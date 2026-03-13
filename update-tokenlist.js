const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const TOKENLIST_PATH = path.join(__dirname, 'tokenlist.json');
const SCHEMA_PATH = path.join(__dirname, 'node_modules/@uniswap/token-lists/src/tokenlist.schema.json');

/**
 * Validate token list against Uniswap token-lists schema
 */
function isValidTokenList(tokenList) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
  const ajv = new Ajv({ allErrors: true, verbose: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(tokenList);
  if (valid) return true;
  return validate.errors;
}

const CHAIN_IDS = {
  Ink: 57073,
  HyperEVM: 999,
  Mantle: 5000,
  Tron: 728126428,
  Sonic: 146,
  Etherlink: 42793,
  Lisk: 1135,
  Base: 8453,
  Fantom: 250,
  Avalanche: 43114,
  Arbitrum: 42161,
  BinanceSmartChain: 56,
  Gnosis: 100,
  Polygon: 137,
  Ethereum: 1
};

// Reverse lookup: chainId -> network name
const CHAIN_NAMES = Object.fromEntries(
  Object.entries(CHAIN_IDS).map(([name, id]) => [id, name])
);

/**
 * Format token as short string: symbol:network
 */
function formatTokenShort(token) {
  const network = CHAIN_NAMES[token.chainId] || `chain-${token.chainId}`;
  return `${token.symbol}:${network}`;
}

/**
 * Calculate semantic version bump and diff summary based on token changes
 * @param {Array} oldTokens - Previous token list
 * @param {Array} newTokens - New token list
 * @param {Object} currentVersion - Current version {major, minor, patch}
 * @returns {Object} { newVersion, summary }
 */
function calculateVersionBump(oldTokens, newTokens, currentVersion) {
  const oldTokenKeys = new Set(
    oldTokens.map(t => `${t.chainId}-${t.address.toLowerCase()}`)
  );
  const newTokenKeys = new Set(
    newTokens.map(t => `${t.chainId}-${t.address.toLowerCase()}`)
  );

  const oldTokenMap = new Map(
    oldTokens.map(t => [`${t.chainId}-${t.address.toLowerCase()}`, t])
  );
  const newTokenMap = new Map(
    newTokens.map(t => [`${t.chainId}-${t.address.toLowerCase()}`, t])
  );

  // Count removals (triggers major bump) - format as short strings
  const removed = [];
  for (const key of oldTokenKeys) {
    if (!newTokenKeys.has(key)) {
      removed.push(formatTokenShort(oldTokenMap.get(key)));
    }
  }

  // Count additions (triggers minor bump) - format as short strings
  const added = [];
  for (const key of newTokenKeys) {
    if (!oldTokenKeys.has(key)) {
      added.push(formatTokenShort(newTokenMap.get(key)));
    }
  }

  // Count modifications (triggers patch bump) - format as before/after records
  const modified = [];
  for (const [key, newToken] of newTokenMap) {
    const oldToken = oldTokenMap.get(key);
    if (oldToken) {
      const changes = {};
      if (oldToken.name !== newToken.name) {
        changes.name = { before: oldToken.name, after: newToken.name };
      }
      if (oldToken.symbol !== newToken.symbol) {
        changes.symbol = { before: oldToken.symbol, after: newToken.symbol };
      }
      if (oldToken.logoURI !== newToken.logoURI) {
        changes.logoURI = { before: oldToken.logoURI, after: newToken.logoURI };
      }
      if (oldToken.decimals !== newToken.decimals) {
        changes.decimals = { before: oldToken.decimals, after: newToken.decimals };
      }
      if (Object.keys(changes).length > 0) {
        modified.push({
          token: formatTokenShort(newToken),
          changes
        });
      }
    }
  }

  // Build version bump reasons (can be simultaneous)
  const reasons = [];
  if (removed.length > 0) reasons.push(`major: ${removed.length} token(s) removed`);
  if (added.length > 0) reasons.push(`minor: ${added.length} token(s) added`);
  if (modified.length > 0) reasons.push(`patch: ${modified.length} token(s) modified`);

  // Calculate new version - highest precedence wins for actual bump
  const newVersion = { ...currentVersion };

  if (removed.length > 0) {
    newVersion.major += 1;
    newVersion.minor = 0;
    newVersion.patch = 0;
  } else if (added.length > 0) {
    newVersion.minor += 1;
    newVersion.patch = 0;
  } else if (modified.length > 0) {
    newVersion.patch += 1;
  }

  const versionBumpReason = reasons.length > 0 ? reasons.join('; ') : 'none';

  return {
    newVersion,
    summary: {
      added: added.length,
      removed: removed.length,
      modified: modified.length,
      addedTokens: added,
      removedTokens: removed,
      modifiedTokens: modified,
      versionBumpReason
    }
  };
}

/**
 * Update README.md with current token statistics
 */
function updateReadme(tokens) {
  const readmePath = path.join(__dirname, 'README.md');

  if (!fs.existsSync(readmePath)) {
    console.log('README.md not found, skipping update');
    return;
  }

  let readme = fs.readFileSync(readmePath, 'utf8');

  // Calculate token counts per network
  const countPerChain = tokens.reduce((acc, token) => {
    const name = CHAIN_NAMES[token.chainId] || `Chain-${token.chainId}`;
    acc[name] = (acc[name] || 0) + 1;
    return acc;
  }, {});

  // Build new statistics table
  let statsTable = '| Network | Tokens |\n|---------|--------|\n';
  Object.entries(countPerChain)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, count]) => {
      statsTable += `| ${name} | ${count} |\n`;
    });
  statsTable += `| **Total** | **${tokens.length}** |`;

  // Replace the statistics table in README (handle both \n and \r\n line endings)
  const statsPattern = /## Token Statistics\r?\n\r?\n\| Network \| Tokens \|\r?\n\|[-]+\|[-]+\|\r?\n[\s\S]*?\| \*\*Total\*\* \| \*\*\d+\*\* \|/;

  if (statsPattern.test(readme)) {
    readme = readme.replace(statsPattern, `## Token Statistics\n\n${statsTable}`);
    fs.writeFileSync(readmePath, readme);
    console.log('Updated README.md');
  } else {
    console.log('Token Statistics section not found in README.md, skipping update');
  }
}

/**
 * Append entry to CHANGELOG.md
 */
function appendChangelog(version, summary, timestamp) {
  const changelogPath = path.join(__dirname, 'CHANGELOG.md');
  const header = '# Changelog\n\nAll notable changes to the xStocks Token List.\n\n';

  let existingEntries = '';
  if (fs.existsSync(changelogPath)) {
    const changelog = fs.readFileSync(changelogPath, 'utf8');
    // Extract everything after the header
    const headerPattern = /^# Changelog\n\nAll notable changes to the xStocks Token List\.\n\n/;
    existingEntries = changelog.replace(headerPattern, '');
  }

  const versionStr = `${version.major}.${version.minor}.${version.patch}`;
  const date = timestamp.split('T')[0];

  let entry = `## [${versionStr}] - ${date}\n\n`;

  if (summary.added > 0) {
    entry += `### Added\n`;
    summary.addedTokens.forEach(t => {
      entry += `- ${t}\n`;
    });
    entry += '\n';
  }

  if (summary.removed > 0) {
    entry += `### Removed\n`;
    summary.removedTokens.forEach(t => {
      entry += `- ${t}\n`;
    });
    entry += '\n';
  }

  if (summary.modified > 0) {
    entry += `### Changed\n`;
    summary.modifiedTokens.forEach(m => {
      const changeDetails = Object.entries(m.changes)
        .map(([field, { before, after }]) => `${field}: "${before}" → "${after}"`)
        .join(', ');
      entry += `- ${m.token}: ${changeDetails}\n`;
    });
    entry += '\n';
  }

  const newChangelog = header + entry + existingEntries;

  fs.writeFileSync(changelogPath, newChangelog);
  console.log(`Updated CHANGELOG.md`);
}

/**
 * Update token list with new tokens
 * @param {Array} newTokens - Array of token objects with at minimum: chainId, address, name, symbol, decimals
 *                            logoURI and tags will be auto-generated if not provided
 */
function updateTokenList(newTokens) {
  // Read current tokenlist
  const tokenlist = JSON.parse(fs.readFileSync(TOKENLIST_PATH, 'utf8'));
  const oldTokens = tokenlist.tokens;

  // Process new tokens - add logoURI and tags if not present
  const processedTokens = newTokens.map(token => ({
    chainId: token.chainId,
    address: token.address,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
    logoURI: `https://xstocks-metadata.backed.fi/logos/tokens/${token.symbol}.png`,
    tags:['xStocks']
  }));

  // Calculate version bump and get summary
  const { newVersion, summary } = calculateVersionBump(oldTokens, processedTokens, tokenlist.version);

  // Update tokenlist
  tokenlist.tokens = processedTokens;
  tokenlist.version = newVersion;
  tokenlist.timestamp = new Date().toISOString();

  // Validate using Uniswap token-lists schema
  const validationErrors = isValidTokenList(tokenlist);

  if (validationErrors !== true) {
    console.error('Validation failed:');
    console.error(JSON.stringify(validationErrors, null, 2));
    process.exit(1);
  }

  console.log('Validation passed!\n');

  // Log summary
  const newVersionStr = `${newVersion.major}.${newVersion.minor}.${newVersion.patch}`;

  console.log('=== Update Summary ===');
  console.log(`Version: ${newVersionStr}`);
  console.log(`Total tokens: ${processedTokens.length}`);
  console.log('');
  console.log(`Added:    ${summary.added}`);
  console.log(`Removed:  ${summary.removed}`);
  console.log(`Modified: ${summary.modified}`);
  console.log('');
  console.log(`Version bump: ${summary.versionBumpReason}`);

  if (summary.added > 0) {
    console.log('\nAdded tokens:');
    summary.addedTokens.forEach(t => console.log(`  + ${t}`));
  }

  if (summary.removed > 0) {
    console.log('\nRemoved tokens:');
    summary.removedTokens.forEach(t => console.log(`  - ${t}`));
  }

  if (summary.modified > 0) {
    console.log('\nModified tokens:');
    summary.modifiedTokens.forEach(m => {
      const changeDetails = Object.entries(m.changes)
        .map(([field, { before, after }]) => `${field}: "${before}" → "${after}"`)
        .join(', ');
      console.log(`  ~ ${m.token}: ${changeDetails}`);
    });
  }

  // Write updated tokenlist
  fs.writeFileSync(TOKENLIST_PATH, JSON.stringify(tokenlist, null, 4) + '\n');
  console.log('\nUpdated tokenlist.json');

  // Append to changelog if there were changes
  if (summary.added > 0 || summary.removed > 0 || summary.modified > 0) {
    appendChangelog(newVersion, summary, tokenlist.timestamp);
  }

  // Update README with current token statistics
  updateReadme(processedTokens);

  return tokenlist;
}

/**
 * Replace entire token array from a JSON file or inline data
 * Usage: node update-tokenlist.js <path-to-new-tokens.json>
 *        OR import and call replaceTokens(newTokensArray)
 */
function replaceTokens(newTokens) {
  return updateTokenList(newTokens);
}

// CLI usage
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node update-tokenlist.js <path-to-new-tokens.json>');
    console.log('');
    console.log('The JSON file should contain an array of token objects with:');
    console.log('  - chainId: number');
    console.log('  - address: string');
    console.log('  - name: string');
    console.log('  - symbol: string');
    console.log('  - decimals: number');
    console.log('');
    console.log('logoURI and tags will be auto-generated.');
    console.log('');
    console.log('Available chain IDs:');
    Object.entries(CHAIN_IDS).forEach(([name, id]) => {
      console.log(`  ${name}: ${id}`);
    });
    process.exit(0);
  }

  const newTokensPath = args[0];
  const newTokens = JSON.parse(fs.readFileSync(newTokensPath, 'utf8'));

  replaceTokens(newTokens);
}

module.exports = { updateTokenList, replaceTokens, calculateVersionBump, CHAIN_IDS };
