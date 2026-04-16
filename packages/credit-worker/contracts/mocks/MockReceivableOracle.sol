// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../interfaces/IReceivableOracle.sol";

contract MockReceivableOracle is IReceivableOracle {
    struct Receivable {
        bool exists;
        address beneficiary;
        uint256 amount;
        bool settled;
    }

    mapping(bytes32 => Receivable) public receivables;

    function register(bytes32 id, address beneficiary, uint256 amount) external {
        receivables[id] = Receivable(true, beneficiary, amount, false);
    }

    function settle(bytes32 id) external {
        receivables[id].settled = true;
    }

    function getReceivable(bytes32 receivableId) external view override returns (
        bool exists, address beneficiary, uint256 amount, bool settled
    ) {
        Receivable storage r = receivables[receivableId];
        return (r.exists, r.beneficiary, r.amount, r.settled);
    }
}
