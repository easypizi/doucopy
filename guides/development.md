# Development

```bash
make install
make build
make test
make typecheck
```

To validate the npm tarball before publishing: `npm pack` then `npm i -g ./doucopy-*.tgz`. `npm run sync-skills` mirrors `.cursor/skills/doucopy-{ask,answer,troubleshoot}` into the `skills/` directory that ships in the tarball. It runs automatically on `prepack`.

The package ships two bin names: `doucopy` and the legacy `agent-link` alias, for anyone who installed it under the old name.
