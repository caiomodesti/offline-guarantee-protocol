const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const defaultResolveRequest = config.resolver.resolveRequest;

/**
 * The shared NodeNext build correctly uses explicit `.js` specifiers for
 * TypeScript source modules. Metro does not map those specifiers back to the
 * source `.ts` file, so production bundling needs this narrow compatibility
 * resolver. Package imports and actual JavaScript files keep Metro's default
 * behavior.
 */
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if ((moduleName.startsWith("./") || moduleName.startsWith("../")) && moduleName.endsWith(".js")) {
    const sourceModule = moduleName.slice(0, -3);
    try {
      return context.resolveRequest(context, sourceModule, platform);
    } catch {
      // Fall through so a real JavaScript module still resolves normally.
    }
  }

  if (typeof defaultResolveRequest === "function") {
    return defaultResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
