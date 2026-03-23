// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "../interfaces/IReceivableOracle.sol";

/**
 * @title RegistryReceivableOracle
 * @notice A receivable oracle backed by on-chain fund locking.
 *
 * Registration requires the receivable to be funded (tokens locked here).
 * This ensures the oracle only reports receivables backed by real capital.
 *
 * For native on-chain escrows (Claw Earn, etc.), write a direct adapter
 * that reads their contract state instead of using this registry.
 */
contract RegistryReceivableOracle is IReceivableOracle {
    using SafeERC20 for IERC20;

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
        require(_token != address(0), "zero token");
        token = IERC20(_token);
    }

    function register(bytes32 id, address beneficiary, uint256 amount) external {
        require(!receivables[id].exists, "already exists");
        require(amount > 0, "zero amount");
        require(beneficiary != address(0), "zero beneficiary");

        // State update before external call (CEI pattern)
        receivables[id] = Receivable({
            beneficiary: beneficiary,
            funder: msg.sender,
            amount: amount,
            exists: true,
            settled: false
        });

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit ReceivableRegistered(id, beneficiary, msg.sender, amount);
    }

    function settle(bytes32 id) external {
        Receivable storage r = receivables[id];
        require(r.exists, "not found");
        require(!r.settled, "already settled");
        require(msg.sender == r.funder, "only funder can settle");

        r.settled = true;
        token.safeTransfer(r.beneficiary, r.amount);
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
