// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IReactive } from "@reactive/src/interfaces/IReactive.sol";
import { ISystemContract } from "@reactive/src/interfaces/ISystemContract.sol";

/// Test-only USDC with 6 decimals.
contract TestUSDC is ERC20 {
    constructor() ERC20("Test USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to_, uint256 amount_) external {
        _mint(to_, amount_);
    }
}

/// Stand-in for the Reactive system contract. Its runtime code is placed at 0x8888...8888 in tests, so calls it
/// makes to react() come from the address AbstractReactive expects.
contract MockSystem {
    struct Sub {
        uint256 chainId;
        address contractAddress;
        uint256 topic0;
        uint256 topic1;
        uint256 topic2;
        uint256 topic3;
        bool active;
    }

    Sub[] public subs;
    ISystemContract.CallbackConfiguration_V_1_0[] internal _callbacks;

    function subscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        subs.push(Sub(c, a, t0, t1, t2, t3, true));
    }

    function unsubscribe(uint256 c, address a, uint256 t0, uint256 t1, uint256 t2, uint256 t3) external {
        for (uint256 i = 0; i < subs.length; i++) {
            Sub storage s = subs[i];
            if (s.active && s.chainId == c && s.contractAddress == a && s.topic0 == t0 && s.topic1 == t1
                && s.topic2 == t2 && s.topic3 == t3) {
                s.active = false;
            }
        }
    }

    function requestCallbackV_1_0(ISystemContract.CallbackConfiguration_V_1_0 memory config_) external {
        _callbacks.push(config_);
    }

    function subCount() external view returns (uint256) {
        return subs.length;
    }

    function callbackCount() external view returns (uint256) {
        return _callbacks.length;
    }

    function callbackAt(uint256 i) external view returns (ISystemContract.CallbackConfiguration_V_1_0 memory) {
        return _callbacks[i];
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    function deliver(address target_, IReactive.LogRecord calldata log_) external {
        IReactive(payable(target_)).react(log_);
    }
}

/// Stand-in for a destination chain's callback proxy: overwrites the first argument with the requesting
/// reactive contract, as the real proxy does, then calls the recipient.
contract MockProxy {
    error RelayFailed(bytes reason);

    function relay(address recipient_, address reactive_, bytes calldata payload_) external {
        bytes memory p = payload_;
        assembly {
            mstore(add(p, 36), reactive_)
        }
        (bool ok, bytes memory ret) = recipient_.call(p);
        if (!ok) revert RelayFailed(ret);
    }

    function debt(address) external pure returns (uint256) {
        return 0;
    }

    receive() external payable {}
}
