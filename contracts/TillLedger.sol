// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

/// @title Till: the books.
/// @notice One ledger for a merchant that is paid on several chains. Written only by callbacks from the merchant's
/// TillReactive contract, through the Reactive callback proxy. Each origin log is booked at most once.
contract TillLedger is AbstractCallback {
    struct ChainBook {
        uint256 gross;
        uint256 sales;
        uint256 swept;
        uint256 float;
        uint256 lastOriginTx;
    }

    event Booked(
        uint256 indexed chainId,
        address indexed payer,
        uint256 amount,
        uint256 originTx,
        bool firstTimePayer,
        uint256 floatAfter
    );
    event SweepRecorded(uint256 indexed chainId, uint256 amount, uint256 sweepTx);
    event ShiftRecorded(uint256 indexed shift, uint256 gross, uint256 sales, uint256 payers);

    mapping(uint256 chainId => ChainBook) public books;
    uint256[] public chainIds;
    mapping(bytes32 originLog => bool) public booked;
    mapping(address payer => uint256) public paidBy;

    uint256 public totalGross;
    uint256 public totalSales;
    uint256 public totalSwept;
    uint256 public payers;
    uint256 public lastShift;

    constructor(IPayable callbackProxy_, address till_) payable AbstractCallback(callbackProxy_, till_) {}

    function book(
        address till_,
        uint256 chainId_,
        address payer_,
        uint256 amount_,
        uint256 originTx_,
        uint256 logIndex_,
        bool firstTimePayer_,
        uint256 floatAfter_
    ) external onlyServiceProvider onlyCallbackSender(till_) {
        bytes32 key = keccak256(abi.encode(chainId_, originTx_, logIndex_));
        if (booked[key]) return; // a redelivered callback must not double-count
        booked[key] = true;

        ChainBook storage b = books[chainId_];
        if (b.sales == 0 && b.swept == 0) chainIds.push(chainId_);
        b.gross += amount_;
        b.sales += 1;
        b.float = floatAfter_;
        b.lastOriginTx = originTx_;

        totalGross += amount_;
        totalSales += 1;
        if (paidBy[payer_] == 0) payers += 1;
        paidBy[payer_] += amount_;

        emit Booked(chainId_, payer_, amount_, originTx_, firstTimePayer_, floatAfter_);
    }

    function recordSweep(address till_, uint256 chainId_, uint256 amount_, uint256 sweepTx_)
        external
        onlyServiceProvider
        onlyCallbackSender(till_)
    {
        ChainBook storage b = books[chainId_];
        if (b.sales == 0 && b.swept == 0) chainIds.push(chainId_);
        b.swept += amount_;
        b.float = b.float > amount_ ? b.float - amount_ : 0;
        totalSwept += amount_;
        emit SweepRecorded(chainId_, amount_, sweepTx_);
    }

    function closeShift(address till_, uint256 shift_, uint256 gross_, uint256 sales_, uint256 payers_)
        external
        onlyServiceProvider
        onlyCallbackSender(till_)
    {
        if (shift_ <= lastShift) return;
        lastShift = shift_;
        emit ShiftRecorded(shift_, gross_, sales_, payers_);
    }

    function chainCount() external view returns (uint256) {
        return chainIds.length;
    }

    /// @notice Settle any debt with the callback proxy from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }
}
