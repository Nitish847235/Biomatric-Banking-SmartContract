// /test/biometricBanking.test.js

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("BiometricBanking", function () {
    let biometricBanking;
    let owner, user1, user2, recipient;
    let ONE_ETHER;

    // Helper function to get a future timestamp
    const getFutureTimestamp = (seconds) => Math.floor(Date.now() / 1000) + seconds;

    beforeEach(async function () {
        // Get signers from Hardhat network
        [owner, user1, user2, recipient] = await ethers.getSigners();
        
        // A constant for 1 Ether
        ONE_ETHER = ethers.parseEther("1");

        // Deploy a new instance of the contract before each test
        const BiometricBankingFactory = await ethers.getContractFactory("BiometricBanking");
        biometricBanking = await BiometricBankingFactory.deploy();
    });

    // ===================================
    //      Deployment and Registration
    // ===================================

    describe("Deployment and Registration", function () {
        it("Should set the right owner", async function () {
            expect(await biometricBanking.owner()).to.equal(owner.address);
        });

        it("Should allow a new user to register", async function () {
            const userId = "user1-id";
            await expect(biometricBanking.connect(user1).registerUser(userId))
                .to.not.be.reverted;

            expect(await biometricBanking.userWallets(user1.address)).to.equal(userId);
            expect(await biometricBanking.userIds(userId)).to.equal(user1.address);
        });

        it("Should prevent registering an already taken userId", async function () {
            const userId = "shared-id";
            await biometricBanking.connect(user1).registerUser(userId);

            await expect(biometricBanking.connect(user2).registerUser(userId))
                .to.be.revertedWith("UserId already taken");
        });

        it("Should prevent an already registered address from registering again", async function () {
            await biometricBanking.connect(user1).registerUser("user1-id");

            await expect(biometricBanking.connect(user1).registerUser("user1-another-id"))
                .to.be.revertedWith("Already registered");
        });
    });

    // ===================================
    //      Fund Management
    // ===================================

    describe("Fund Management (Deposit & Withdraw)", function () {
        beforeEach(async function () {
            await biometricBanking.connect(user1).registerUser("user1-id");
        });

        it("Should allow a user to deposit Ether", async function () {
            await biometricBanking.connect(user1).deposit({ value: ONE_ETHER });
            const balance = await biometricBanking.walletBalances(user1.address);
            expect(balance).to.equal(ONE_ETHER);
        });
        
        it("Should accept Ether via receive() fallback", async function () {
            await user1.sendTransaction({
                to: await biometricBanking.getAddress(),
                value: ONE_ETHER,
            });
            expect(await biometricBanking.walletBalances(user1.address)).to.equal(ONE_ETHER);
        });

        it("Should allow a user to withdraw their balance", async function () {
            await biometricBanking.connect(user1).deposit({ value: ONE_ETHER });
            
            const amountToWithdraw = ethers.parseEther("0.5");
            
            await expect(biometricBanking.connect(user1).withdraw(amountToWithdraw))
                .to.changeEtherBalances(
                    [user1, biometricBanking],
                    [amountToWithdraw, `-${amountToWithdraw}`]
                );
            
            expect(await biometricBanking.walletBalances(user1.address)).to.equal(ethers.parseEther("0.5"));
        });

        it("Should fail withdrawal if balance is insufficient", async function () {
            await expect(biometricBanking.connect(user1).withdraw(ONE_ETHER))
                .to.be.revertedWithCustomError(biometricBanking, "InsufficientBalance");
        });

        it("Should be protected from re-entrancy attacks on withdraw", async function () {
            const Attacker = await ethers.getContractFactory("Attacker");
            const attacker = await Attacker.deploy(await biometricBanking.getAddress());
            
            // Attacker funds the contract
            await biometricBanking.connect(user1).deposit({ value: ethers.parseEther("10") });
            await attacker.connect(user1).depositToBiometric({ value: ONE_ETHER });

            // Expect the attack to fail because of the nonReentrant modifier
            await expect(attacker.attackWithdraw()).to.be.revertedWithCustomError(biometricBanking, "WithdrawFailed");
        });
    });

    // ===================================
    //      Full Transaction Workflow
    // ===================================

    describe("Full Transaction Workflow", function () {
        const userId = "test-user-id";
        const txnId = "txn-001";
        const description = "Payment for services";
        const amount = ethers.parseEther("0.5");
        const txnData = "biometric-scan-data-user1-abc-123";
        let txnDataHash;

        beforeEach(async function () {
            // Setup for the workflow
            txnDataHash = ethers.keccak256(ethers.toUtf8Bytes(txnData));
            await biometricBanking.connect(user1).registerUser(userId);
            await biometricBanking.connect(user1).deposit({ value: ONE_ETHER });
        });

        it("Should successfully complete the entire transaction flow", async function () {
            // Step 2: Admin initiates transaction
            const expiresAt = await time.latest() + 3600; // 1 hour from now
            await expect(biometricBanking.connect(owner).initiateTransaction(txnId, userId, description, amount, txnData, expiresAt))
                .to.emit(biometricBanking, "TransactionInitiated")
                .withArgs(userId, txnId);

            const tx = await biometricBanking.getTransaction(txnId);
            expect(tx.userId).to.equal(userId);
            expect(tx.amount).to.equal(amount);
            expect(tx.verified).to.be.false;
            expect(tx.completed).to.be.false;

            // Step 3: User verifies transaction
            await expect(biometricBanking.connect(user1).verifyTransaction(txnId, userId, txnData))
                .to.emit(biometricBanking, "TransactionVerified")
                .withArgs(userId, txnId);
            
            const verifiedTx = await biometricBanking.getTransaction(txnId);
            expect(verifiedTx.verified).to.be.true;

            // Step 4: Admin completes transaction
            const userContractBalanceBefore = await biometricBanking.getUserBalance(userId);
            
            const txCmpl = await biometricBanking.connect(owner).completeTransaction(txnId, recipient.address);

            await expect(txCmpl)
                .to.emit(biometricBanking, "TransactionCompleted")
                .withArgs(userId, txnId, amount, recipient.address);

            await expect(txCmpl)
                .to.changeEtherBalances(
                    [biometricBanking, recipient],
                    [`-${amount}`, amount]
                );

            const userContractBalanceAfter = await biometricBanking.getUserBalance(userId);
            expect(userContractBalanceBefore - userContractBalanceAfter).to.equal(amount);
            
            const completedTx = await biometricBanking.getTransaction(txnId);
            expect(completedTx.completed).to.be.true;
        });
        
        it("Should log transaction history for the user", async function() {
            const expiresAt = await time.latest() + 3600;
            await biometricBanking.connect(owner).initiateTransaction(txnId, userId, description, amount, txnData, expiresAt);
            
            const log = await biometricBanking.getUserTransactionLog(userId);
            expect(log).to.have.lengthOf(1);
            expect(log[0]).to.equal(txnId);
        });
    });

    // ===================================
    //      Error Handling & Edge Cases
    // ===================================

    describe("Error Handling and Edge Cases", function () {
        const userId = "edge-user";
        const txnId = "txn-edge";
        const amount = ethers.parseEther("1");
        const txnData = "edge-case-data";

        beforeEach(async function () {
            await biometricBanking.connect(user1).registerUser(userId);
            // user1 deposits only 0.5 ETH for the insufficient balance test
            await biometricBanking.connect(user1).deposit({ value: ethers.parseEther("0.5") });
        });
        
        // --- Initiation Errors ---
        it("Should fail to initiate if not owner", async function () {
            await expect(biometricBanking.connect(user1).initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(60)))
                .to.be.revertedWithCustomError(biometricBanking, "OwnableUnauthorizedAccount");
        });

        it("Should fail to initiate if txnId already exists", async function () {
            const expiresAt = getFutureTimestamp(60);
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, expiresAt);
            await expect(biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, expiresAt))
                .to.be.revertedWithCustomError(biometricBanking, "TransactionAlreadyExists");
        });

        // --- Verification Errors ---
        it("Should fail verification if sender is not the user", async function () {
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(60));
            await expect(biometricBanking.connect(user2).verifyTransaction(txnId, userId, txnData))
                .to.be.revertedWithCustomError(biometricBanking, "Unauthorized");
        });

        it("Should fail verification if transaction is expired", async function () {
            const expiresAt = await time.latest() + 10; // Expires in 10 seconds
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, expiresAt);
            
            // Fast forward time
            await time.increase(15);
            
            await expect(biometricBanking.connect(user1).verifyTransaction(txnId, userId, txnData))
                .to.be.revertedWithCustomError(biometricBanking, "TransactionExpired");
        });

        it("Should fail verification if biometric data does not match", async function () {
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(180));
            await expect(biometricBanking.connect(user1).verifyTransaction(txnId, userId, "wrong-data"))
                .to.be.revertedWithCustomError(biometricBanking, "TransactionDataMismatch");
        });

        // --- Completion Errors ---
        it("Should fail completion if not owner", async function () {
            await expect(biometricBanking.connect(user1).completeTransaction(txnId, recipient.address))
                .to.be.revertedWithCustomError(biometricBanking, "OwnableUnauthorizedAccount");
        });

        it("Should fail completion if transaction is not verified", async function () {
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(60));
            await expect(biometricBanking.completeTransaction(txnId, recipient.address))
                .to.be.revertedWithCustomError(biometricBanking, "TransactionNotVerified");
        });

        it("Should fail completion if user has insufficient balance", async function () {
            // User1 has 0.5 ETH, transaction requires 1 ETH
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(300));
            await biometricBanking.connect(user1).verifyTransaction(txnId, userId, txnData);
            
            await expect(biometricBanking.completeTransaction(txnId, recipient.address))
                .to.be.revertedWithCustomError(biometricBanking, "InsufficientBalance");
        });

        it("Should fail to complete a transaction twice", async function () {
            // This time, give the user enough funds
            await biometricBanking.connect(user1).deposit({ value: ONE_ETHER });
            
            await biometricBanking.initiateTransaction(txnId, userId, "desc", amount, txnData, getFutureTimestamp(600));
            await biometricBanking.connect(user1).verifyTransaction(txnId, userId, txnData);
            await biometricBanking.completeTransaction(txnId, recipient.address);

            // Try to complete it again
            await expect(biometricBanking.completeTransaction(txnId, recipient.address))
                .to.be.revertedWithCustomError(biometricBanking, "TransactionAlreadyCompleted");
        });
    });
});
