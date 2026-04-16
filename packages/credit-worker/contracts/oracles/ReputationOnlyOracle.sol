// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../interfaces/IReceivableOracle.sol";
import "../interfaces/IReputationRegistry.sol";
import "../interfaces/ICreditOracle.sol";

/**
 * @title ReputationOnlyOracle
 * @notice Receivable oracle that creates virtual (uncollateralized) receivables
 *         backed only by an agent's reputation score.
 *
 * Agents call register() to bind a receivableId to their address. The oracle
 * reads credit limits LIVE from the CreditOracle at query time — never from
 * a stale snapshot. This means the escrow always sees the agent's current
 * creditworthiness, not what it was when they registered.
 *
 * The escrow's own credit check (_updateExposureAndCheckCredit) provides a
 * second layer of enforcement, but this oracle is the authoritative source
 * of reputation-based credit data.
 */
contract ReputationOnlyOracle is IReceivableOracle {
    struct VirtualReceivable {
        address beneficiary;
        bool exists;
    }

    IReputationRegistry public immutable reputationRegistry;
    ICreditOracle public immutable creditOracle;
    uint256 public minScore;

    address public governance;
    address public pendingGovernance;
    uint256 public governanceProposedAt;
    uint256 public constant GOVERNANCE_ACCEPT_WINDOW = 7 days;

    mapping(bytes32 => VirtualReceivable) public receivables;
    mapping(address => uint256) public nonces;

    event VirtualReceivableCreated(bytes32 indexed id, address indexed agent);
    event MinScoreUpdated(uint256 oldScore, uint256 newScore);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceCancelled(address indexed cancelled);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    constructor(
        address _reputationRegistry,
        address _creditOracle,
        uint256 _minScore
    ) {
        require(_reputationRegistry != address(0), "zero registry");
        require(_creditOracle != address(0), "zero credit oracle");
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        creditOracle = ICreditOracle(_creditOracle);
        minScore = _minScore;
        governance = msg.sender;

        emit MinScoreUpdated(0, _minScore);
        emit GovernanceTransferred(address(0), msg.sender);
    }

    function register() external returns (bytes32 receivableId) {
        (uint256 repScore,) = reputationRegistry.getReputation(msg.sender);
        require(repScore >= minScore, "score too low");

        (,, uint256 maxExposure) = creditOracle.getCredit(msg.sender);
        require(maxExposure > 0, "no credit limit");

        uint256 nonce = ++nonces[msg.sender];
        receivableId = keccak256(abi.encode(msg.sender, nonce));

        receivables[receivableId] = VirtualReceivable({
            beneficiary: msg.sender,
            exists: true
        });

        emit VirtualReceivableCreated(receivableId, msg.sender);
    }

    function getReceivable(bytes32 receivableId) external view override returns (
        bool exists,
        address beneficiary,
        uint256 amount,
        bool settled
    ) {
        VirtualReceivable storage r = receivables[receivableId];
        if (!r.exists) return (false, address(0), 0, false);

        (,, uint256 maxExposure) = creditOracle.getCredit(r.beneficiary);
        return (true, r.beneficiary, maxExposure, false);
    }

    function setMinScore(uint256 _minScore) external onlyGovernance {
        emit MinScoreUpdated(minScore, _minScore);
        minScore = _minScore;
    }

    function proposeGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "zero address");
        pendingGovernance = newGovernance;
        governanceProposedAt = block.timestamp;
        emit GovernanceProposed(newGovernance);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "not pending");
        require(block.timestamp <= governanceProposedAt + GOVERNANCE_ACCEPT_WINDOW, "proposal expired");
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
        governanceProposedAt = 0;
    }

    function cancelGovernanceProposal() external onlyGovernance {
        require(pendingGovernance != address(0), "no pending proposal");
        emit GovernanceCancelled(pendingGovernance);
        pendingGovernance = address(0);
        governanceProposedAt = 0;
    }
}
