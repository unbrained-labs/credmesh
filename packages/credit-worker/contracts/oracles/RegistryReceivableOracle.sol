// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IReceivableOracle.sol";

/**
 * @title RegistryReceivableOracle
 * @notice A receivable oracle backed by on-chain registrations.
 *
 * Use cases:
 *   - Our own marketplace jobs (registered when job is created + funded)
 *   - Any off-chain receivable that has been verified and registered
 *   - Bridge to external escrow systems (adapter pattern)
 *
 * For native on-chain escrows (Claw Earn, etc.), write a direct adapter
 * that reads their contract state instead of using this registry.
 *
 * Registration requires the receivable to be funded (tokens locked here).
 * This ensures the oracle only reports receivables backed by real capital.
 */
contract RegistryReceivableOracle is IReceivableOracle {
    struct Receivable {
        address beneficiary;
        address funder;
        uint256 amount;
        bool exists;
        bool settled;
    }

    IERC20 public immutable token;
    mapping(bytes32 => Receivable) public receivables;

    event ReceivableRegistered(bytes32 indexed id, address indexed beneficiary, address indexed funder, uint256 amount);
    event ReceivableSettled(bytes32 indexed id, address indexed beneficiary, uint256 amount);

    constructor(address _token) {
        token = IERC20(_token);
    }

    /**
     * @notice Register a receivable by locking funds.
     *         Anyone can fund a receivable for any beneficiary.
     * @param id          Unique receivable identifier
     * @param beneficiary Who will receive the payout (the worker/agent)
     * @param amount      How much to escrow
     */
    function register(bytes32 id, address beneficiary, uint256 amount) external {
        require(!receivables[id].exists, "already exists");
        require(amount > 0, "zero amount");
        require(beneficiary != address(0), "zero beneficiary");

        // State update before external call (checks-effects-interactions)
        receivables[id] = Receivable({
            beneficiary: beneficiary,
            funder: msg.sender,
            amount: amount,
            exists: true,
            settled: false
        });

        require(token.transferFrom(msg.sender, address(this), amount), "transfer failed");

        emit ReceivableRegistered(id, beneficiary, msg.sender, amount);
    }

    /**
     * @notice Mark a receivable as settled and release funds to beneficiary.
     *         Only the funder can settle (they confirm work was delivered).
     */
    function settle(bytes32 id) external {
        Receivable storage r = receivables[id];
        require(r.exists, "not found");
        require(!r.settled, "already settled");
        require(msg.sender == r.funder, "only funder can settle");

        r.settled = true;
        require(token.transfer(r.beneficiary, r.amount), "transfer failed");

        emit ReceivableSettled(id, r.beneficiary, r.amount);
    }

    // ─── IReceivableOracle ───

    function getReceivable(bytes32 receivableId) external view override returns (
        bool exists,
        address beneficiary,
        uint256 amount,
        bool settled
    ) {
        Receivable storage r = receivables[receivableId];
        return (r.exists, r.beneficiary, r.amount, r.settled);
    }
}

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}
