// SPDX-License-Identifier: MIT
pragma solidity >0.8.0;

import {UI,Menu,Target,Input} from './lib/Menu.sol';

contract Home {
    using UI for Menu;
    using UI for Target;
    function menu (Menu m)
        external
    {
        m.title("Welcome to my Program!")
         .text("Here is a button")
         .text("press it to do do stuff")

         .target("ok")
         .action(this.onOK.selector)
         .action(this.onOK.selector, address(this))
         .action(this.onOK.selector, "Home")
         .set("yay", "1234")
         .prop("nop", 4438, "Value Name")
         .prop("bool", false, "Another Values Name")
         .validate("nop", address(this), this.validateBlah.selector)
         .button("DO STUFF")

         .target("cancel")
         .action(this.onOK.selector)
         .note("This is permanent!")
         .note("Another Note!")
         .button("CANCEL!")

         .target('derp')

         ;
    }

    function validateBlah(uint8 value)
        public pure
        returns (bool)
    {

    }

    function onOK (Menu m, Input[] memory inputs)
        external
    {
        m.title('Second Menu')
         .text('Jello World')
         .title('Blaah')
         .text('Example')
         .target('Go Back')
         .action(this.menu.selector)
         ;
    }
}