// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../interfaces/ICreditOracle.sol";
import "../interfaces/IReputationRegistry.sol";

interface IIdentityRegistry {
    function getAgent(address agent) external view returns (bytes memory);
}

/// @title ReputationCreditOracle
/// @notice Credit oracle gating advances on ERC-8004 reputation score plus
///         identity-registered bonus. No collateral. Score capped at 100.
///         maxExposure = score * exposureMultiplier * (1 + identityBonusBps/10000) if registered.
contract ReputationCreditOracle is ICreditOracle {
    IReputationRegistry public immutable reputationRegistry;
    address public immutable escrow;
    uint256 public exposureMultiplier;
    address public governance;
    address public pendingGovernance;

    IIdentityRegistry public identityRegistry;
    uint256 public identityBonusMultiplier;
    uint256 public constant MAX_IDENTITY_BONUS = 10000;

    uint256 public constant MIN_MULTIPLIER = 1;
    uint256 public constant MAX_MULTIPLIER = 100_000e6;

    event ExposureMultiplierUpdated(uint256 oldValue, uint256 newValue);
    event IdentityRegistryUpdated(address indexed oldRegistry, address indexed newRegistry, uint256 bonusBps);
    event GovernanceProposed(address indexed newGovernance);
    event GovernanceTransferred(address indexed oldGovernance, address indexed newGovernance);

    modifier onlyGovernance() {
        require(msg.sender == governance, "not governance");
        _;
    }

    constructor(
        address _reputationRegistry,
        address _escrow,
        uint256 _exposureMultiplier,
        address _identityRegistry,
        uint256 _identityBonusMultiplier
    ) {
        require(_reputationRegistry != address(0), "zero registry");
        require(_escrow != address(0), "zero escrow");
        require(_exposureMultiplier >= MIN_MULTIPLIER && _exposureMultiplier <= MAX_MULTIPLIER, "multiplier out of range");
        require(_identityBonusMultiplier <= MAX_IDENTITY_BONUS, "bonus too high");
        reputationRegistry = IReputationRegistry(_reputationRegistry);
        escrow = _escrow;
        exposureMultiplier = _exposureMultiplier;
        identityRegistry = IIdentityRegistry(_identityRegistry);
        identityBonusMultiplier = _identityBonusMultiplier;
        governance = msg.sender;
        emit IdentityRegistryUpdated(address(0), _identityRegistry, _identityBonusMultiplier);
    }

    function setExposureMultiplier(uint256 _multiplier) external onlyGovernance {
        require(_multiplier >= MIN_MULTIPLIER && _multiplier <= MAX_MULTIPLIER, "out of range");
        emit ExposureMultiplierUpdated(exposureMultiplier, _multiplier);
        exposureMultiplier = _multiplier;
    }

    function proposeGovernance(address newGovernance) external onlyGovernance {
        require(newGovernance != address(0), "zero address");
        pendingGovernance = newGovernance;
        emit GovernanceProposed(newGovernance);
    }

    function acceptGovernance() external {
        require(msg.sender == pendingGovernance, "not pending");
        emit GovernanceTransferred(governance, msg.sender);
        governance = msg.sender;
        pendingGovernance = address(0);
    }

    function setIdentityRegistry(address _registry, uint256 _bonusMultiplier) external onlyGovernance {
        require(_bonusMultiplier <= MAX_IDENTITY_BONUS, "bonus too high");
        address old = address(identityRegistry);
        identityRegistry = IIdentityRegistry(_registry);
        identityBonusMultiplier = _bonusMultiplier;
        emit IdentityRegistryUpdated(old, _registry, _bonusMultiplier);
    }

    function getCredit(address agent) external view override returns (
        uint256 score,
        uint256 totalExposure,
        uint256 maxExposure
    ) {
        (uint256 repScore,) = reputationRegistry.getReputation(agent);
        score = repScore > 100 ? 100 : repScore;
        totalExposure = ITrustlessEscrow(escrow).exposure(agent);
        maxExposure = score * exposureMultiplier;
        if (address(identityRegistry) != address(0) && identityBonusMultiplier > 0) {
            try identityRegistry.getAgent(agent) returns (bytes memory data) {
                if (data.length > 0) {
                    maxExposure += (maxExposure * identityBonusMultiplier) / 10000;
                }
            } catch {}
        }
    }
}

interface ITrustlessEscrow {
    function exposure(address agent) external view returns (uint256);
}
