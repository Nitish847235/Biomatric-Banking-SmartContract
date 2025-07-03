// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract BiometricBanking is ReentrancyGuard, Ownable {
    struct Transaction {
        string userId;
        string description;
        uint128 amount;
        bytes32 txnDataHash;
        bool verified;
        bool completed;
        bool expired;
        uint32 createdAt;
        uint32 expiresAt;
    }

    mapping(string => Transaction) public transactions;
    mapping(string => bytes32) private userHashes;
    mapping(address => uint256) public walletBalances;
    mapping(address => string) public userWallets;
    mapping(string => address) public userIds; // userId => address
    mapping(string => string[]) public userTransactionLog;

    event TransactionInitiated(string userId, string txnId);
    event TransactionVerified(string userId, string txnId);
    event TransactionCompleted(string userId, string txnId, uint256 amount, address to);
    event TransactionFailed(string userId, string txnId, string reason);
    event LogEntry(string userId, string message);

    error InsufficientBalance();
    error Unauthorized();
    error TransactionExpired();
    error TransactionAlreadyExists();
    error TransactionAlreadyCompleted();
    error TransactionNotVerified();
    error TransactionDataMismatch();
    error WithdrawFailed();

    constructor() Ownable(msg.sender) ReentrancyGuard() {}

    // Step 1: Register user with userId
    function registerUser(string memory userId) public {
        require(bytes(userWallets[msg.sender]).length == 0, "Already registered");
        require(userIds[userId] == address(0), "UserId already taken");

        userWallets[msg.sender] = userId;
        userIds[userId] = msg.sender;
    }

    // Step 2: Admin initiates transaction
    function initiateTransaction(
        string memory txnId,
        string memory userId,
        string memory description,
        uint128 amount,
        string memory txnData,
        uint32 expiresAt
    ) public onlyOwner {
        if (transactions[txnId].amount != 0) revert TransactionAlreadyExists();

        bytes32 txnHash = keccak256(abi.encodePacked(txnData));

        transactions[txnId] = Transaction({
            userId: userId,
            description: description,
            amount: amount,
            txnDataHash: txnHash,
            verified: false,
            completed: false,
            expired: false,
            createdAt: uint32(block.timestamp),
            expiresAt: uint32(expiresAt)
        });

        userHashes[userId] = txnHash;
        userTransactionLog[userId].push(txnId);

        emit TransactionInitiated(userId, txnId);
        emit LogEntry(userId, "Transaction initiated.");
    }

    // Step 3: User verifies transaction with biometric data
    function verifyTransaction(string memory txnId, string memory userId, string memory txnData) public returns (bool) {
        if (userIds[userId] != msg.sender) revert Unauthorized();

        Transaction storage txn = transactions[txnId];

        if (txn.completed) revert TransactionAlreadyCompleted();
        if (block.timestamp > txn.expiresAt) {
            txn.expired = true;
            emit TransactionFailed(userId, txnId, "Transaction expired");
            revert TransactionExpired();
        }

        if (txn.txnDataHash != keccak256(abi.encodePacked(txnData))) revert TransactionDataMismatch();

        txn.verified = true;
        emit TransactionVerified(userId, txnId);
        emit LogEntry(userId, "Transaction verified via biometric.");

        return true;
    }

    // Step 4: Admin completes verified transaction
    function completeTransaction(string memory txnId, address payable to) public onlyOwner nonReentrant {
        Transaction storage txn = transactions[txnId];
        address userAddr = userIds[txn.userId];

        if (!txn.verified) revert TransactionNotVerified();
        if (txn.completed) revert TransactionAlreadyCompleted();
        if (walletBalances[userAddr] < txn.amount) revert InsufficientBalance();

        walletBalances[userAddr] -= txn.amount;
        txn.completed = true;

        (bool success, ) = to.call{value: txn.amount}("");
        require(success, "Transfer failed");

        emit TransactionCompleted(txn.userId, txnId, txn.amount, to);
        emit LogEntry(txn.userId, "Transaction completed and funds transferred.");
    }

    // Step 5: Optional biometric signature support (for future use)
    function getSigner(bytes32 messageHash, uint8 v, bytes32 r, bytes32 s) public pure returns (address) {
        return ecrecover(messageHash, v, r, s);
    }

    // Step 6: Deposit funds to your balance
    function deposit() public payable {
        walletBalances[msg.sender] += msg.value;
    }

    // Step 7: Withdraw funds
    function withdraw(uint256 amount) public nonReentrant {
        if (walletBalances[msg.sender] < amount) revert InsufficientBalance();
        walletBalances[msg.sender] -= amount;
        (bool success, ) = payable(msg.sender).call{value: amount}("");
        if(!success) revert WithdrawFailed();
        emit LogEntry(
            userWallets[msg.sender],
            string(
                abi.encodePacked(
                    "Withdrawal successful: ",
                    _uintToString(amount),
                    " wei."
                )
            )
        );
    }

    // Step 8: View a transaction
    function getTransaction(string memory txnId) public view returns (
        string memory userId,
        string memory description,
        uint128 amount,
        bool verified,
        bool completed,
        bool expired,
        uint32 createdAt,
        uint32 expiresAt
    ) {
        Transaction memory txn = transactions[txnId];
        return (
            txn.userId,
            txn.description,
            txn.amount,
            txn.verified,
            txn.completed,
            txn.expired,
            txn.createdAt,
            txn.expiresAt
        );
    }

    // Step 9: View a user's transaction history
    function getUserTransactionLog(string memory userId) public view returns (string[] memory) {
        return userTransactionLog[userId];
    }

    // Internal helper to convert uint256 to string
    function _uintToString(uint256 value) internal pure returns (string memory) {
        if (value == 0) {
            return "0";
        }
        uint256 temp = value;
        uint256 digits;
        while (temp != 0) {
            digits++;
            temp /= 10;
        }
        bytes memory buffer = new bytes(digits);
        while (value != 0) {
            digits -= 1;
            buffer[digits] = bytes1(uint8(48 + uint256(value % 10)));
            value /= 10;
        }
        return string(buffer);
    }

    // Step 10: Get user balance by userId
    function getUserBalance(string memory userId) public view returns (uint256) {
        address userAddr = userIds[userId];
        return walletBalances[userAddr];
    }

    // Fallback to accept ETH
    receive() external payable {
        walletBalances[msg.sender] += msg.value;
    }
}
