// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CreditVault
 * @notice ERC-4626 vault for agent credit liquidity.
 *
 * Depositors provide tUSDC → receive vault shares.
 * The vault supplies capital to CreditEscrow for agent advances.
 * Fees from repayments flow back to the vault, increasing share value.
 *
 * Optionally routes idle capital to Aave V3 for base yield.
 * Self-custodial: depositors can always withdraw their share.
 */

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

interface IAToken {
    function balanceOf(address account) external view returns (uint256);
}

contract CreditVault is ERC4626, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Aave integration (optional — set to address(0) if not available)
    IAavePool public aavePool;
    IAToken public aToken;
    bool public aaveEnabled;

    // Escrow integration
    address public escrow;

    // Accounting
    uint256 public totalAdvancedOut;    // capital currently in escrow for advances
    uint256 public totalFeesEarned;     // cumulative fees (increases share value)
    uint256 public totalDefaultLoss;    // cumulative losses

    event CapitalSupplied(address indexed escrow, uint256 amount);
    event CapitalReturned(uint256 principal, uint256 fees);
    event DefaultLossRecorded(uint256 amount);
    event AaveDeposited(uint256 amount);
    event AaveWithdrawn(uint256 amount);

    constructor(
        IERC20 _asset,
        string memory _name,
        string memory _symbol
    ) ERC4626(_asset) ERC20(_name, _symbol) Ownable(msg.sender) {}

    // ─── Aave Configuration ───

    function setAave(address _pool, address _aToken) external onlyOwner {
        aavePool = IAavePool(_pool);
        aToken = IAToken(_aToken);
        aaveEnabled = _pool != address(0) && _aToken != address(0);
    }

    function setEscrow(address _escrow) external onlyOwner {
        escrow = _escrow;
    }

    // ─── Capital Management ───

    /// @notice Total assets = tokens held + tokens in Aave + tokens in escrow (minus losses)
    function totalAssets() public view override returns (uint256) {
        uint256 held = IERC20(asset()).balanceOf(address(this));
        uint256 inAave = aaveEnabled ? aToken.balanceOf(address(this)) : 0;
        // totalAdvancedOut tracks capital in escrow; adjusted for known losses
        return held + inAave + totalAdvancedOut;
    }

    /// @notice Owner supplies capital from vault to escrow for advances
    function supplyToEscrow(uint256 amount) external onlyOwner nonReentrant {
        require(escrow != address(0), "no escrow set");

        uint256 available = IERC20(asset()).balanceOf(address(this));

        // If not enough liquid, withdraw from Aave
        if (available < amount && aaveEnabled) {
            uint256 needed = amount - available;
            uint256 aaveBal = aToken.balanceOf(address(this));
            uint256 toWithdraw = needed > aaveBal ? aaveBal : needed;
            aavePool.withdraw(asset(), toWithdraw, address(this));
            emit AaveWithdrawn(toWithdraw);
            available = IERC20(asset()).balanceOf(address(this));
        }

        require(available >= amount, "insufficient funds");
        IERC20(asset()).safeTransfer(escrow, amount);
        totalAdvancedOut += amount;
        emit CapitalSupplied(escrow, amount);
    }

    /// @notice Record repayment from escrow (principal + fees returned to vault)
    function recordRepayment(uint256 principal, uint256 fees) external onlyOwner nonReentrant {
        totalAdvancedOut = principal > totalAdvancedOut ? 0 : totalAdvancedOut - principal;
        totalFeesEarned += fees;
        // Fees increase totalAssets() without increasing totalSupply(),
        // which means each share is now worth more — depositors earn yield.
        emit CapitalReturned(principal, fees);
    }

    /// @notice Record a default loss (reduces totalAdvancedOut since capital is gone)
    function recordDefault(uint256 lossAmount) external onlyOwner nonReentrant {
        totalAdvancedOut = lossAmount > totalAdvancedOut ? 0 : totalAdvancedOut - lossAmount;
        totalDefaultLoss += lossAmount;
        emit DefaultLossRecorded(lossAmount);
    }

    // ─── Aave Yield ───

    /// @notice Deposit idle capital into Aave for base yield
    function depositToAave(uint256 amount) external onlyOwner nonReentrant {
        require(aaveEnabled, "aave not configured");
        uint256 available = IERC20(asset()).balanceOf(address(this));
        require(available >= amount, "insufficient idle capital");

        IERC20(asset()).safeIncreaseAllowance(address(aavePool), amount);
        aavePool.supply(asset(), amount, address(this), 0);
        emit AaveDeposited(amount);
    }

    /// @notice Withdraw capital from Aave back to vault
    function withdrawFromAave(uint256 amount) external onlyOwner nonReentrant {
        require(aaveEnabled, "aave not configured");
        aavePool.withdraw(asset(), amount, address(this));
        emit AaveWithdrawn(amount);
    }

    // ─── View ───

    function vaultStats() external view returns (
        uint256 _totalAssets,
        uint256 _totalShares,
        uint256 _sharePrice,
        uint256 _idleBalance,
        uint256 _inAave,
        uint256 _inEscrow,
        uint256 _feesEarned,
        uint256 _defaultLoss
    ) {
        uint256 shares = totalSupply();
        return (
            totalAssets(),
            shares,
            shares > 0 ? (totalAssets() * 1e6) / shares : 1e6, // price per share in 6 decimals
            IERC20(asset()).balanceOf(address(this)),
            aaveEnabled ? aToken.balanceOf(address(this)) : 0,
            totalAdvancedOut,
            totalFeesEarned,
            totalDefaultLoss
        );
    }
}
