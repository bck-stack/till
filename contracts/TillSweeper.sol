// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPayable } from "@reactive/src/interfaces/IPayable.sol";
import { AbstractCallback } from "@reactive/src/base/AbstractCallback.sol";

/// @title Till: the sweeper on one chain.
/// @notice Moves the merchant's USDC float to the vault. It can only ever send to the vault fixed at deployment,
/// only up to what the merchant approved, and only when asked by the merchant's TillReactive contract.
/// It never reverts on a failed move: it always reports `Swept`, so the reactive side can clear its pending flag.
contract TillSweeper is AbstractCallback {
    event Swept(address indexed vault, uint256 amount);

    IERC20 public immutable usdc;
    address public immutable payTo;
    address public immutable vault;

    constructor(IPayable callbackProxy_, address till_, IERC20 usdc_, address payTo_, address vault_)
        payable
        AbstractCallback(callbackProxy_, till_)
    {
        usdc = usdc_;
        payTo = payTo_;
        vault = vault_;
    }

    function sweep(address till_) external onlyServiceProvider onlyCallbackSender(till_) {
        uint256 balance = usdc.balanceOf(payTo);
        uint256 allowed = usdc.allowance(payTo, address(this));
        uint256 amount = balance < allowed ? balance : allowed;
        uint256 moved = 0;
        if (amount > 0) {
            (bool ok, bytes memory ret) =
                address(usdc).call(abi.encodeCall(IERC20.transferFrom, (payTo, vault, amount)));
            if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) moved = amount;
        }
        emit Swept(vault, moved);
    }

    function coverDebt() external {
        _coverDebt();
    }
}
