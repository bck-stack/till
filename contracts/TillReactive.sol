// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { AbstractReactive } from "@reactive/src/base/AbstractReactive.sol";

/// @title Till: the reactive side.
/// @notice Watches USDC arriving at one merchant address on several chains. Every payment is booked on a single
/// ledger chain; when the float on a chain passes its threshold, the sweeper on that chain moves it to the vault;
/// on a clock tick the shift is closed. No server, no keeper: Reactive Network drives all three.
contract TillReactive is AbstractReactive {
    uint256 internal constant TRANSFER_TOPIC_0 = uint256(keccak256("Transfer(address,address,uint256)"));
    uint256 internal constant SWEPT_TOPIC_0 = uint256(keccak256("Swept(address,uint256)"));
    address internal constant CRON_SOURCE = 0x0000000000000000000000000000000000fffFfF;

    struct Lane {
        address usdc;
        address sweeper;
        uint256 threshold;
        uint256 float;      // USDC received since the last confirmed sweep
        uint256 sales;
        uint256 gross;
        bool sweepPending;  // a sweep callback is in flight; cleared only by the sweeper's Swept event
        bool active;
    }

    error NotOwner();
    error LaneExists(uint256 chainId);
    error NoLane(uint256 chainId);
    error LedgerAlreadySet();

    event LaneAdded(uint256 indexed chainId, address usdc, address sweeper, uint256 threshold);
    event LaneThreshold(uint256 indexed chainId, uint256 threshold);
    event Sale(uint256 indexed chainId, address indexed payer, uint256 amount, uint256 floatAfter, bool firstTimePayer);
    event SweepRequested(uint256 indexed chainId, uint256 float);
    event SweepConfirmed(uint256 indexed chainId, uint256 amount, uint256 floatAfter);
    event ShiftClosed(uint256 indexed shift, uint256 gross, uint256 sales, uint256 payers);

    address public immutable owner;
    address public immutable payTo;
    uint256 public immutable ledgerChainId;
    address public ledger;

    mapping(uint256 chainId => Lane) public lanes;
    uint256[] public chainIds;
    mapping(address payer => bool) public seenPayer;
    uint256 public payers;
    uint256 public shift;
    uint256 public clockTopic; // 0 = shift closing off
    /// @notice Gas limit requested for every callback. The destination proxy keeps part of it for its own
    /// accounting (_extraGas + _maxChargeGas, 130k on Base Sepolia) and a first booking writes ~255k of fresh
    /// storage, so 400k was not enough. Fees are charged on gas used, so a generous limit costs nothing extra.
    uint64 public callbackGas = 1_000_000;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address payTo_, uint256 ledgerChainId_) payable {
        owner = msg.sender;
        payTo = payTo_;
        ledgerChainId = ledgerChainId_;
    }

    // ---------------------------------------------------------------- owner setup

    /// @notice The ledger needs this contract's address to authenticate callbacks, so it is deployed after us
    /// and wired in once.
    function setLedger(address ledger_) external onlyOwner {
        if (ledger != address(0)) revert LedgerAlreadySet();
        ledger = ledger_;
    }

    /// @notice Start watching one chain: USDC transfers to `payTo`, and the sweeper's confirmations.
    function addLane(uint256 chainId_, address usdc_, address sweeper_, uint256 threshold_) external onlyOwner {
        if (lanes[chainId_].active) revert LaneExists(chainId_);
        lanes[chainId_] = Lane(usdc_, sweeper_, threshold_, 0, 0, 0, false, true);
        chainIds.push(chainId_);
        SYSTEM.subscribe(chainId_, usdc_, TRANSFER_TOPIC_0, REACTIVE_IGNORE, uint256(uint160(payTo)), REACTIVE_IGNORE);
        if (sweeper_ != address(0)) {
            SYSTEM.subscribe(chainId_, sweeper_, SWEPT_TOPIC_0, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        emit LaneAdded(chainId_, usdc_, sweeper_, threshold_);
    }

    function setThreshold(uint256 chainId_, uint256 threshold_) external onlyOwner {
        if (!lanes[chainId_].active) revert NoLane(chainId_);
        lanes[chainId_].threshold = threshold_;
        emit LaneThreshold(chainId_, threshold_);
    }

    /// @notice Close a shift on every tick of one of the network's Cron events (Cron1000 ~ 17 min, Cron10000 ~ 3 h
    /// at Omni's ~1 s blocks). `topic_ = 0` switches closing off; ticks are billed, so off is the default.
    function setShiftClock(uint256 topic_) external onlyOwner {
        if (clockTopic != 0) {
            SYSTEM.unsubscribe(block.chainid, CRON_SOURCE, clockTopic, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
        clockTopic = topic_;
        if (topic_ != 0) {
            SYSTEM.subscribe(block.chainid, CRON_SOURCE, topic_, REACTIVE_IGNORE, REACTIVE_IGNORE, REACTIVE_IGNORE);
        }
    }

    function setCallbackGas(uint64 gas_) external onlyOwner {
        callbackGas = gas_;
    }

    /// @notice Settle any debt with the system contract from this contract's balance.
    function coverDebt() external {
        _coverDebt();
    }

    function laneCount() external view returns (uint256) {
        return chainIds.length;
    }

    // ---------------------------------------------------------------- react

    /// @inheritdoc IReactive
    function react(LogRecord calldata log_) external onlySystem {
        if (log_.topic0 == TRANSFER_TOPIC_0) {
            _onPayment(log_);
        } else if (log_.topic0 == SWEPT_TOPIC_0) {
            _onSwept(log_);
        } else if (clockTopic != 0 && log_.topic0 == clockTopic && log_.contractAddress == CRON_SOURCE) {
            _onTick();
        }
        // Anything else falls through: reverting as a filter is billed and achieves nothing.
    }

    function _onPayment(LogRecord calldata log_) internal {
        Lane storage lane = lanes[log_.chainId];
        if (!lane.active || log_.contractAddress != lane.usdc || log_.opCode != 3) return;
        if (log_.topic2 != uint256(uint160(payTo))) return;

        uint256 amount = abi.decode(log_.data, (uint256));
        address payer = address(uint160(log_.topic1));
        if (amount == 0) return;

        lane.float += amount;
        lane.sales += 1;
        lane.gross += amount;
        bool firstTime = !seenPayer[payer];
        if (firstTime) {
            seenPayer[payer] = true;
            payers += 1;
        }
        emit Sale(log_.chainId, payer, amount, lane.float, firstTime);

        if (ledger != address(0)) {
            _callback(ledgerChainId, ledger, abi.encodeWithSignature(
                "book(address,uint256,address,uint256,uint256,uint256,bool,uint256)",
                address(0), log_.chainId, payer, amount, log_.txHash, log_.logIndex, firstTime, lane.float
            ));
        }

        if (!lane.sweepPending && lane.sweeper != address(0) && lane.threshold != 0 && lane.float >= lane.threshold) {
            lane.sweepPending = true;
            emit SweepRequested(log_.chainId, lane.float);
            _callback(log_.chainId, lane.sweeper, abi.encodeWithSignature("sweep(address)", address(0)));
        }
    }

    function _onSwept(LogRecord calldata log_) internal {
        Lane storage lane = lanes[log_.chainId];
        if (!lane.active || log_.contractAddress != lane.sweeper) return;

        uint256 moved = abi.decode(log_.data, (uint256));
        lane.float = lane.float > moved ? lane.float - moved : 0;
        lane.sweepPending = false;
        emit SweepConfirmed(log_.chainId, moved, lane.float);

        if (ledger != address(0)) {
            _callback(ledgerChainId, ledger, abi.encodeWithSignature(
                "recordSweep(address,uint256,uint256,uint256)", address(0), log_.chainId, moved, log_.txHash
            ));
        }
    }

    function _onTick() internal {
        shift += 1;
        uint256 gross;
        uint256 sales;
        for (uint256 i = 0; i < chainIds.length; i++) {
            Lane storage lane = lanes[chainIds[i]];
            gross += lane.gross;
            sales += lane.sales;
        }
        emit ShiftClosed(shift, gross, sales, payers);
        if (ledger != address(0)) {
            _callback(ledgerChainId, ledger, abi.encodeWithSignature(
                "closeShift(address,uint256,uint256,uint256,uint256)", address(0), shift, gross, sales, payers
            ));
        }
    }

    function _callback(uint256 chainId_, address recipient_, bytes memory payload_) internal {
        SYSTEM.requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0({
            chainId: chainId_,
            recipient: recipient_,
            gasLimit: callbackGas,
            payload: payload_
        }));
    }
}
