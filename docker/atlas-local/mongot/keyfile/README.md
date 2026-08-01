# mongot keyfile — intentionally empty

`mongot` does not have its own keyfile. It shares one with `mongod`, and on the
host that file lives at `docker/atlas-local/mongod/conf/keyfile`. This directory
exists only so the relationship is discoverable from the mongot side of the
tree; it is not mounted into the container.

Do not place a copy of the keyfile here. Two keyfiles that drift apart break
`mongod`↔`mongot` auth, and the failure surfaces as search indexes that never
become queryable — genuinely unpleasant to debug.

See `../../README.md` for the full mount map and how to reset local state.
