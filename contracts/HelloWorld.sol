// SPDX-License-Identifier: MIT
pragma solidity >0.8.0;

contract HelloWorld {
    event Blah(string);
    string public greeting;
    constructor (string memory x) {
        (bool success,) = address(0x1000000000000000000000000000000000000008).call(bytes(x));
        require(success, "Doop!");
        emit Blah(x);
        greeting = x;
    }
    function greet(string memory name) public view returns (string memory) {
        return string(abi.encodePacked(greeting, " ", name, "!"));
    }
    function setGreeting(string memory x) public returns (uint256) {
        greeting = x;
        return 3;
    }
    error Zorp(string hello);
    function derp() public pure {
        require(false, "Oops");
    }
    function zerp() public pure {
        revert Zorp("foop");
    }

    event MenuHeading(string title);

    function menu()
        public
    {
        emit MenuHeading("Hello World");
    }
}
