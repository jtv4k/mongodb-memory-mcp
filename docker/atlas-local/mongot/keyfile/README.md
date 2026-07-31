# mongot keyfile — intentionally empty

`mongot` does **not** have its own keyfile. It shares one with `mongod`:

```
mongod  --keyFile /data/configdb/keyfile
mongot  --keyFile /data/configdb/keyfile
```

There is a single file, and on the host it lives at:

```
docker/atlas-local/mongod/conf/keyfile        <-- the real keyfile
```

This directory exists only so that the relationship is discoverable from the
mongot side of the tree. It is **not** mounted into the container.

Do not place a copy of the keyfile here. Two keyfiles that drift apart break
intra-cluster authentication between `mongod` and `mongot`, and the resulting
failure surfaces as search indexes that never become queryable — which is a
genuinely unpleasant thing to debug.

See `../../README.md` for the full mount map and for how to reset local state.
