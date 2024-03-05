import { join, basename, dirname } from 'path'
import { glob } from 'glob';
import { default as enquirer } from 'enquirer';
import { readFile } from 'fs/promises';
import { Blockchain } from '@ethereumjs/blockchain';
import { VM } from '@ethereumjs/vm';
import { Chain, Common, Hardfork } from '@ethereumjs/common';
import { EVM, ExecResult, PrecompileInput } from '@ethereumjs/evm';
import { DefaultStateManager } from '@ethereumjs/statemanager';
import { Address, Account, hexToBytes } from '@ethereumjs/util';
import { LegacyTransaction, LegacyTxData } from '@ethereumjs/tx';
import { randomFillSync } from 'crypto'

import { AbiCoder, ErrorFragment, EventFragment, FunctionFragment, Interface,
         hexlify } from 'ethers';

const common = new Common({ chain: Chain.Mainnet, hardfork: Hardfork.Shanghai });

function precompile_random_bytes(opts: PrecompileInput) : ExecResult {
  const args = AbiCoder.defaultAbiCoder().decode(['uint256', 'bytes'], opts.data);
  console.log('randomBytes Request', args);
  const rd = randomFillSync(new Uint8Array(args[0]));
  return {
    executionGasUsed: 10n,
    returnValue: rd,
}
}

function precompile_example(opts: PrecompileInput): ExecResult {
  console.log('precompile_example', new TextDecoder().decode(opts.data));
  return {
      executionGasUsed: 10n,
      returnValue: new Uint8Array(),
  }
}

function precompile_jsonrpc(opts: PrecompileInput): ExecResult {
  // JSON-RPC, provide URL and arg encoding & decoding
  const args = AbiCoder.defaultAbiCoder().decode(['string', 'bytes'], opts.data);
  console.log('precompile_jsonrpc', new TextDecoder().decode(opts.data));
  return {
      executionGasUsed: 10n,
      returnValue: new Uint8Array(),
  }
}

const DEFAULT_DATA: Partial<LegacyTxData> = {
  nonce: BigInt(0),
  gasLimit: 2_000_000, // We assume that 2M is enough,
  gasPrice: 1,
  value: 0,
  data: '0x',
} as const;

export const buildTransaction = (data: Partial<LegacyTxData>): LegacyTxData => {
  return {
    ...DEFAULT_DATA,
    ...data,
  }
}

async function mineTx(
  vm: VM,
  senderPrivateKey: Uint8Array,
  txData:LegacyTxData
)
{
  const addr = Address.fromPrivateKey(senderPrivateKey);
  const acct = (await vm.stateManager.getAccount(addr))!;

  const tx = LegacyTransaction.fromTxData(
    buildTransaction({
      nonce: acct.nonce,
      gasPrice: 7,
      ...txData,
    }),
    {common, allowUnlimitedInitCodeSize: true}
  );

  const signedTx = tx.sign(senderPrivateKey);

  const r = await vm.runTx({
    tx:signedTx,
    skipBalance: true,
    skipBlockGasLimitValidation: true
  });

  if (r.execResult.exceptionError) {
    throw r.execResult.exceptionError
  }

  acct.nonce += 1n;
  vm.stateManager.putAccount(addr, acct);

  return r;
}

async function deployContract(
  vm: VM,
  w: Wallet,
  contract: ContractInfoT,
  args: unknown[],
) {
  // Contracts are deployed by sending their deployment bytecode to the address 0
  // The contract params should be abi-encoded and appended to the deployment bytecode.

  const abi = contract.iface;
  const encodedArgs = abi.encodeDeploy(args);
  const txData:LegacyTxData = {
    data: hexToBytes('0x' + contract.bytecode + encodedArgs.slice(2)),
  }
  const r = await mineTx(vm, w.sk, txData);
  return r.createdAddress!
}

async function insertAccount (vm: VM, address: Address) {
  const acctData = {
    nonce: 0,
    balance: BigInt(10) ** BigInt(18), // 1 eth
  }
  const account = Account.fromAccountData(acctData);
  await vm.stateManager.putAccount(address, account);
  return await vm.stateManager.getAccount(address);
}

const CUSTOM_PRECOMPILES = [
  {address: Address.fromString('0x1000000000000000000000000000000000000008'),
   function: precompile_example},
  {address: Address.fromString('0x0100000000000000000000000000000000000001'),
   function: precompile_random_bytes},
   {address: Address.fromString('0x0100000000000000000000000000000000000002'),
   function: precompile_jsonrpc},
];


async function makeVM () {
  const stateManager = new DefaultStateManager()
  const blockchain = await Blockchain.create()

  const evm = new EVM({
    common,
    stateManager,
    blockchain,
    customPrecompiles: CUSTOM_PRECOMPILES
  });

  const vm = await VM.create({evm});

  return vm;
}

async function makeTx(vm:VM, senderPrivateKey:Uint8Array, c:ContractInfoT, addr:Address, fname:string, ...args:unknown[])
{
  const abi = c.iface;
  const fn = abi.getFunction(fname)!;
  const data = hexToBytes(abi.encodeFunctionData(fn, args));

  const txData:LegacyTxData = {
    data,
    to: addr
  }
  const result = await mineTx(vm, senderPrivateKey, txData);

  if( result.execResult.exceptionError ) {
    throw abi.parseError(result.execResult.returnValue);
  }
  const decoded = abi.decodeFunctionResult(fn, result.execResult.returnValue);
  if( decoded.length === 1 ) {
    return decoded[0];
  }
  if( decoded.length === 0 ) {
    return;
  }
  return decoded;
}


type ContractInfoT = {
  name:string
  bytecode:string,
  iface:Interface
};

function mapListPush<K,V>(x:Map<K,V[]>, k:K, v:V) {
  if( ! x.has(k) ) {
    x.set(k, new Array());
  }
  const y = x.get(k)!;
  y.push(v);
}

class Factory {
  constructor(
    public contracts = new Map<String,ContractInfoT>(),
    public selectors = new Map<String,[ContractInfoT,FunctionFragment][]>(),
    public events = new Map<String,[ContractInfoT,EventFragment][]>(),
    public errors = new Map<String,[ContractInfoT,ErrorFragment][]>()
  )
  { }

  public add(contractName:string, info:ContractInfoT) {
    this.contracts.set(contractName, info);
    const fragments = info.iface.fragments;
    for( const entry of fragments ) {
      if( entry.type === 'function' ) {
        mapListPush(this.selectors, (entry as FunctionFragment).selector, [info,entry]);
      }
      else if( entry.type == 'event' ) {
        mapListPush(this.events, (entry as EventFragment).topicHash, [info,entry]);
      }
      else if( entry.type == 'error' ) {
        mapListPush(this.errors, (entry as ErrorFragment).selector, [info,entry]);
      }
      else if( entry.type == 'constructor' ) {
        // Do nothing
      }
      else {
        console.log('Unknown type', entry.type, entry);
      }
    }
  }

  static async LoadFromBuildDir() {
    const fac = new Factory();
    const abiPattern = join('build', '*.abi');
    const files = await glob(abiPattern);
    for( const f of files ) {
      const abi = JSON.parse(new TextDecoder().decode(await readFile(f)));
      const iface = Interface.from(abi);
      const bn = basename(f);
      const contractName = bn.slice(0, bn.length - 4);
      const binFilename = join(dirname(f), `${contractName}.bin`)
      const bytecode = new TextDecoder().decode(await readFile(binFilename));
      const obj:ContractInfoT = {
        bytecode,
        iface,
        name:contractName
      };
      fac.add(contractName, obj);
    }
    return fac;
  }
}

class Wallet
{
  public address: Address;
  public sk: Uint8Array;

  constructor (in_sk?:Uint8Array)
  {
    this.sk = in_sk ?? randomFillSync(new Uint8Array(32));
    this.address = Address.fromPrivateKey(this.sk)
  }

  async tx(instance:ContractInstance, fname:string, ...args:any[]) {
    return instance.tx(this, fname, ...args);
  }
}

type ContractLogT = [ContractInstance,string,...any[]];

class ContractInstance
{
  constructor(public address:Address, public contract:Contract) { }

  public has(name:string) {
    return this.contract.info.iface.getFunction(name) ? true : false;
  }

  async query(fname:string, ...args:any[]) {
    const c = this.contract.info;
    const abi = c.iface;
    const fn = abi.getFunction(fname)!;
    const data = hexToBytes(abi.encodeFunctionData(fn, args));
    const receipt = await this.contract.client.vm.evm.runCall({
      data,
      to: this.address
    });

    if( receipt.execResult.exceptionError ) {
      throw abi.parseError(receipt.execResult.returnValue);
    }
    const logs: ContractLogT[] = [];
    if( receipt.execResult.logs ) {
      for( const l of receipt.execResult.logs )
      {
        const addr = new Address(l[0]);
        const origin = this.contract.client.addrToContract.get(addr.toString());
        if( ! origin ) {
          throw new Error(`Origin unknown ${origin}`);
        }

        const e = this.contract.client.factory.events;
        const efs = e.get(hexlify(l[1][0]))
        if( efs && efs.length > 0 ) {
          const [efc,ef] = efs[0];
          const evdata = efc.iface.decodeEventLog(ef, l[2]);
          logs.push([origin, ef.name, ...Object.values(evdata)]);
        }
        else {
          console.log('Unrecognized log!', origin, l[1], l[2]);
        }
      }
    }
    return {
      result: abi.decodeFunctionResult(fn, receipt.execResult.returnValue),
      logs:logs
    };
  }

  async tx(w:Wallet, fname:string, ...args:any[]) {
    return await makeTx(this.contract.client.vm, w.sk, this.contract.info, this.address, fname, ...args);
  }
}

class Contract
{
  constructor (public client:Client, public info:ContractInfoT)
  { }

  async deploy(w:Wallet, ...args:any[]) {
    const deploymentKey = this.info.name.toLocaleLowerCase();
    if( args.length == 0 ) {
      if( this.client.deployments.has(deploymentKey) ) {
        return this.client.deployments.get(deploymentKey)!;
      }
    }
    const address = await deployContract(this.client.vm, w, this.info, args);
    const o = new ContractInstance(address, this);
    if( args.length == 0 ) {
      this.client.deployments.set(deploymentKey, o);
    }
    this.client.addrToContract.set(address.toString(), o)
    return o;
  }
  public instance(address:Address)
  {
    return new ContractInstance(address, this);
  }
}

class Client {
  constructor(
    public vm: VM,
    public factory: Factory,
    public deployments=new Map<String,ContractInstance>(),
    public addrToContract=new Map<String,ContractInstance>()
  )
  { }

  async newWallet(sk?:Uint8Array) {
    const wallet = new Wallet(sk);
    await insertAccount(this.vm, wallet.address);
    return wallet;
  }

  public instance (nameOrAddress:string) {
    nameOrAddress = nameOrAddress.toLocaleLowerCase();
    let c = this.addrToContract.get(nameOrAddress);
    if( ! c ) {
      c = this.deployments.get(nameOrAddress);
      if( ! c ) {
        throw new Error(`Unknown contract instance: ${nameOrAddress}`);
      }
    }
    return c;
  }

  public contract (name:string) {
    const info = this.factory.contracts.get(name);
    return new Contract(this, info!);
  }

  async deploy (name:string, ...args:any[]) {
    const w = await this.newWallet();
    const c = this.contract(name);
    return c.deploy(w, ...args);
  }
}

function random32() {
  return randomFillSync(new Uint8Array(32))
}

class Action {
  public fragment:FunctionFragment;
  constructor (
    public client:Client,
    public contract:ContractInstance,
    ...args:any[]
  ) {
    if( args.length == 0 ) {
      throw new Error('Action requires args!')
    }
    if( args.length > 2 ) {
      throw new Error('Too many arguments');
    }
    const factory = client.factory;
    const targets = factory.selectors.get(args[0])!;
    let f:FunctionFragment|undefined;
    for( const [contractInfo, fragment] of targets ) {
      f = fragment;
    }
    if( ! f ) {
      throw new Error(`No function fragment found for ${args}`)
    }
    this.fragment = f;
    if( args.length > 1 ) {
      const contractAddress = args[1];
      contract = client.instance(contractAddress);
    }
  }

  public toString() {
    return `${this.contract.contract.info.name} :: ${this.fragment.format()}`
  }
}

class Target {
  public id:string;
  public menu:string;
  public note?:string[];
  public button?:string;
  public action?:Action;
  constructor(c:ContractInstance, client:Client, _items:any[][]) {
    let id:string|undefined;
    let menu:string|undefined;
    for( const t of _items ) {
      const [k, ...v] = t;
      if( k == 'Menu' ) {
        menu = v[0];
      }
      else if( k == 'Id' ) {
        id = v[0];
      }
      else if( k == 'Note' ) {
        if( ! this.note ) {
          this.note = [];
        }
        this.note.push(v[0]);
      }
      else if( k == 'Button' ) {
        this.button = v[0];
      }
      else if( k == 'Action' ) {
        this.action = new Action(client, c, ...v);
      }
    }
    if( ! id || ! menu ) {
      throw new Error(`No ID or menu provided in target ${name}`);
    }
    this.id = id;
    this.menu = menu;
  }
}

function drawButton (label:string) {
  const t = '┈'.repeat(label.length + 2);
  const b = ' '.repeat(label.length + 2);
  console.log(`│  ╭${t}╮`)
  console.log(`│  ┊ ${label} ┊`);
  console.log(`│  ┊${b}╰╌╌┄╌┄┄╌┄┄`)
}

async function driver(client:Client, contractName:string, fname:string, ...args:any[]) {
  let c = client.instance(contractName);
  while( true )
  {
    const state = new Map<string,string>();
    const menuId = random32();
    const {logs} = await c.query(fname, menuId, ...args);
    const {menus} = await parseMenu(client, c, logs);

    console.log('╭' + '╶'.repeat(40));
    console.log(`│ ${c.contract.info.name} (${c.address.toString()})`);
    const fragment = c.contract.info.iface.getFunction(fname);
    if( ! fragment ) {
      throw new Error(`Fragment unknown ${fragment}`);
    }
    console.log(`│ ${fragment.format()}`);
    console.log(`│  - ${hexlify(menuId)}`);
    if( args && args.length ) {
      for( const arg of args ) {
        console.log(`│  - ${JSON.stringify(arg)}`);
      }
    }
    console.log('├' + '╴'.repeat(40));

    const target = await navigator(menus);
    if( ! target ) {
      console.log('│ No target!');
      break;
    }
    const action = target.action;
    if( ! action ) {
      throw new Error(`Target has no action: ${target}`);
    }
    c = action.contract;
    const f = action.fragment;
    if( fragmentIsMenuResponse(f) ) {
      args = [[]];
    }
    else {
      args = [];
    }
    fname = action.fragment.name;
  }
}

class Menu {
  constructor( public items:any[], public targets:Map<String,Target> )
  {

  }
}

async function navigator(menus:Map<string,Menu>) {
  for( const [menuId,m] of menus.entries() ) {
    const targets = m.targets;

    for( const n of m.items ) {
      const [k, ...v] = n;
      if( k == 'Title' ) {
        console.log('│');
        console.log('│ ░', v[0], '░');
        console.log('│');
      }
      else if( k == 'Target' ) {
        const target = targets.get(v[0]);
        console.log('│')
        if( target ) {
          drawButton(target.button ?? target.id);
          if( target.note ) {
            for( const n of target.note ) {
              console.log(`│  ┊ ${n}`);
            }
            console.log('│  ┊ ');
          }
          if( target.action ) console.log(`│  ┊ > ${target.action}`);
        }
        else {
          drawButton(v[0]);
        }
        console.log('│  ╰╌╌┄╌┄┄╌┄┄')
      }
      else if( k == 'Text' ) {
        console.log('│ ',v.join(' '))
      }
      else if( k == 'Id' ) {
        continue;
      }
      else {
        console.log('  ', k, v);
      }
    }
    console.log('╵');

    const choices = [];
    for( const [k,v] of targets.entries() ) {
      choices.push({
        name: k as string,
        message: `${v.button ?? k}`
      });
    }

    const response = await enquirer.prompt({
      type: 'select',
      name: 'option',
      message: 'Pick an option',
      choices
    }) as {option:string} | undefined;

    console.log();

    if( response && response.option ) {
      const opt = response.option;
      return targets.get(opt);
    }
  }
}

function fragmentIsMenuResponse(f:FunctionFragment)
{
  return f.inputs[0].type == 'bytes32'
      && f.inputs.length > 1
      && f.inputs[1].type == 'tuple[]'
      && f.inputs[1].arrayChildren?.components?.length === 2
      && f.inputs[1].arrayChildren!.components![0].type === 'string'
      && f.inputs[1].arrayChildren!.components![1].type === 'string';
}

async function parseMenu(client:Client, contractInstance:ContractInstance, logs:ContractLogT[]) {
  const menusRaw:Record<string,any[]>= {};
  const targetsRaw:Record<string,any[]> = {};
  // Scan gto extract targets
  for( const [i,name,...args] of logs ) {
    if( name.includes('_') ) {
      const s = name.split('_', 2);
      const targetType = s[1];
      if( s[0] == 'Target' ) {
        if( s.length < 2 ) {
          throw new Error(`Invalid target ${name}`);
        }
        const [target, ...rest] = args;
        if( !(target in targetsRaw) ) {
          if( ! (target[0] in menusRaw) ) {
            menusRaw[target[0]] = [
            ];
          }
          menusRaw[target[0]].push([s[0], target[1]]);
          targetsRaw[target] = [
            ['Menu', target[0]],
            ['Id', target[1]]
          ];
        }
        targetsRaw[target].push([targetType, ...rest]);
      }
      else if( s[0] == 'Menu' ) {
        if( s.length < 2 ) {
          throw new Error(`Invalid target ${name}`);
        }
        if( ! (args[0] in menusRaw) ) {
          menusRaw[args[0]] = [
            ['Id', args[0]]
          ];
        }
        menusRaw[args[0]].push([s[1], ...args.slice(1)])
      }
    }
  }

  const menus = new Map<string,Menu>();

  // Rescan to extract menus
  for( const [menuId,m] of Object.entries(menusRaw) ) {
    const targets = new Map<String,Target>();
    for( const [targetId,targetItems] of Object.entries(targetsRaw) ) {
      const [targetMenuId,targetName] = targetId.split(',',2);
      if( menuId != targetMenuId ) {
        console.log('Skipping', targetName);
        continue;
      }
      const target = new Target(contractInstance, client, targetItems);
      targets.set(target.id, target);
      menus.set(menuId, new Menu(m, targets));
    }
  }
  return {menus, menusRaw, targetsRaw};
}

async function main () {
    const w4 = new Client(await makeVM(), await Factory.LoadFromBuildDir());

    //const a = await w4.deploy('HelloWorld', 'Hello');
    //const b = await w4.deploy('HelloWorld', 'World');

    /*
    const wallet = await w4.newWallet();

    console.log(await a.query('greet', 'Harry'));
    console.log(await b.query('greet', 'Joober'));
    //console.log(a.query('derp',));
    console.log(await a.tx(wallet, 'setGreeting', 'Yay'));
    console.log(await a.query('greet', 'Harry'));
    */

    const c = await w4.deploy('Home');
    await driver(w4, 'Home', 'menu');
}

Promise.all([main()]).catch((e) => {
  console.log(e);
})