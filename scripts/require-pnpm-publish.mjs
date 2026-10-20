// prepublishOnly guard for the @mieweb/* packages.
//
// These packages depend on each other with `workspace:*`. Only `pnpm publish`
// (and `changeset publish`, which calls it) rewrites that to a real version;
// `npm publish` uploads it verbatim and the published package can't be
// installed (EUNSUPPORTEDPROTOCOL). That is how @mieweb/deploy-wrangler@0.3.0
// broke. Releases go through .github/workflows/release.yml; to publish by hand,
// use `pnpm publish` from the package directory.
const ua = process.env.npm_config_user_agent ?? '';
if (!ua.startsWith('pnpm/')) {
  console.error(
    `Refusing to publish with "${ua.split(' ')[0] || 'unknown'}": use \`pnpm publish\` ` +
      '(npm publish does not rewrite workspace:* dependencies).',
  );
  process.exit(1);
}
