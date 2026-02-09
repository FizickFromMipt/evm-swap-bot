const chalk = require('chalk');

function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

const logger = {
  info(msg) {
    console.log(chalk.gray(`[${ts()}]`) + chalk.cyan(' [INFO] ') + msg);
  },
  success(msg) {
    console.log(chalk.gray(`[${ts()}]`) + chalk.green(' [OK]   ') + msg);
  },
  warn(msg) {
    console.error(chalk.gray(`[${ts()}]`) + chalk.yellow(' [WARN] ') + msg);
  },
  error(msg) {
    console.error(chalk.gray(`[${ts()}]`) + chalk.red(' [ERR]  ') + msg);
  },
  step(msg) {
    console.log(chalk.gray(`[${ts()}]`) + chalk.magenta(' [STEP] ') + chalk.bold(msg));
  },
  pool(index, pool) {
    const liq = pool.liquidity?.usd ? `$${Number(pool.liquidity.usd).toLocaleString()}` : 'N/A';
    const vol = pool.volume?.h24 ? `$${Number(pool.volume.h24).toLocaleString()}` : 'N/A';
    const pair = `${pool.baseToken.symbol}/${pool.quoteToken.symbol}`;
    const labels = pool.labels?.length ? ` [${pool.labels.join(', ')}]` : '';
    console.log(
      chalk.gray(`[${ts()}]`) +
        chalk.blue(` [POOL #${index + 1}] `) +
        `${chalk.white(pair)} | DEX: ${chalk.yellow(pool.dexId)}${chalk.magenta(labels)} | ` +
        `Liquidity: ${chalk.green(liq)} | Vol 24h: ${chalk.cyan(vol)} | ` +
        `${chalk.gray(pool.pairAddress)}`
    );
  },
  sep() {
    console.log(chalk.gray('\u2500'.repeat(80)));
  },
  banner() {
    console.log(chalk.cyan.bold('\n  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557'));
    console.log(chalk.cyan.bold('  \u2551     BSC Token Buyer CLI Bot             \u2551'));
    console.log(chalk.cyan.bold('  \u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n'));
  },
};

module.exports = logger;
