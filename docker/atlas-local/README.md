# Atlas Local bind mounts

Everything the `mongodb/mongodb-atlas-local:8.0` container persists is bind-mounted
from this directory, so a `docker compose down` never destroys the local knowledge
base and you can inspect the on-disk state from the host.

## What the image actually runs

The image's entrypoint is a compiled Go supervisor, `/usr/local/bin/runner server`,
which starts **two** processes in one container:

```
mongod  --replSet <auto> --dbpath /data/db --keyFile /data/configdb/keyfile \
        --maxConns 32200 --bind_ip_all --transitionToAuth \
        --setParameter mongotHost=localhost:27027 \
        --setParameter searchIndexManagementHostAndPort=localhost:27027

mongot  --keyFile /data/configdb/keyfile --data-dir /data/mongot \
        --mongodHostAndPort localhost:27017
```

`mongot` is the MongoDB Search / Vector Search process. It is the reason `$search`
and `$vectorSearch` behave here exactly as they do in cloud Atlas, which is why
this image — and not a plain `mongo` image — is what dev and CI run against.

## Directory map

| Host path         | Container path   | Owner           | Contents                                         |
| ----------------- | ---------------- | --------------- | ------------------------------------------------ |
| `mongod/data/`    | `/data/db`       | `mongod` (1000) | mongod WiredTiger data files, the oplog, journal |
| `mongod/conf/`    | `/data/configdb` | `mongod` (1000) | `mongod.conf` plus the generated `keyfile`       |
| `mongot/data/`    | `/data/mongot`   | `mongod` (1000) | MongoDB Search index data, `configJournal.json`  |
| `mongot/keyfile/` | _(not mounted)_  | —               | Documentation only — see below                   |

Both `/data/configdb` and `/data/db` are declared as `VOLUME`s by the image;
`/data/mongot` is not, which means search index data is silently thrown away on
container recreation unless it is mounted. That is why it is mounted here.

## The replica set is named after the container hostname

This is the one that will bite you on the second `up`, and it is the reason
`docker-compose.dev.yml` pins `hostname: ragkb-mongodb`.

`runner` initiates the single-node replica set using the container's hostname,
then persists that name into `mongod/data/` as both the replica set name and the
host of its only member:

```
REPLSET NAME: ragkb-mongodb
MEMBER:       ragkb-mongodb:27017
```

Docker defaults a container's hostname to the container ID, which is new every
time the container is recreated. Without a pinned hostname the second `up` loads
a replica set whose only member is a container that no longer exists. mongod
starts, serves connections, and never elects a primary. What you see is:

```
"msg":"Locally stored replica set configuration"   ... NodeNotFound
"error":"PrimarySteppedDown: No primary exists currently"
"error":"ReadConcernMajorityNotAvailableYet: Read concern majority reads are currently not possible."
```

The healthcheck sits at `starting` until it gives up, and the container
eventually exits. Note what this is **not**: it is not a keyfile problem and not
a permissions problem, even though "worked once, fails on recreate" sounds like
both. The keyfile persists correctly in `mongod/conf/`.

**Changing `hostname:` later has exactly the same effect as a changing container
ID** — the stored config still names the old host. If you change it, reset local
state at the same time (below).

## The keyfile is shared, and lives under `mongod/conf/`

`mongod` and `mongot` authenticate to each other with a **single shared
keyfile** — both `--keyFile` flags above point at `/data/configdb/keyfile`,
which is `docker/atlas-local/mongod/conf/keyfile` on the host. `runner`
generates it on first boot, and it is a **secret**: gitignored, mode `0400`.
`mongot/keyfile/` is intentionally empty and not mounted; do not put a copy
there — two divergent keyfiles break intra-cluster auth in a way that is
genuinely painful to diagnose.

**Delete the keyfile and `mongod/data/` together, or neither.** A new keyfile
against an existing replica set will not authenticate, and the converse fails
with an error that does not name the cause:

```
error writing key file: open /data/configdb/keyfile: permission denied
```

That is an empty `mongod/data/` plus a surviving keyfile: the empty data
directory puts `runner` on its initialize path, which rewrites the keyfile, and
the existing one is unwritable even by its owner. It is not a uid problem,
which is the natural first guess. Delete the keyfile
(`rm -f docker/atlas-local/mongod/conf/keyfile`) and boot again; it is
regenerated.

## `mongod.conf` is not read by this image

`runner` starts `mongod` with the explicit command-line flags shown above and
provides no hook for a configuration file, so `mongod/conf/mongod.conf` is
**inert under Atlas Local**. It stays because it documents the effective
configuration in the conventional place, and because it is what takes effect if
this service is ever swapped for a plain `mongod` image. Do not add tuning
there and expect it to apply.

## uid/gid

The container runs as `mongod` = uid **1000**, gid **1000**. That matches the
typical first non-root host account, so bind mounts work without `chown`. If your
host uid is not 1000, `mongod` will fail to write and the container will restart
in a loop — fix it with:

```bash
sudo chown -R 1000:1000 docker/atlas-local
```

## First boot is slow

Initialising the replica set and starting `mongot` takes roughly 20–40 seconds on
a warm image. The compose healthcheck allows for this with a generous
`start_period`. `docker compose logs -f mongodb` shows progress.

## Resetting local state

Do this when the data directory has outlived the hostname that created it —
after changing `hostname:`, or to recover a knowledge base created before that
setting existed:

```bash
docker compose -f docker/docker-compose.yml -f docker/docker-compose.dev.yml down
rm -rf docker/atlas-local/mongod/data/* docker/atlas-local/mongot/data/*
rm -f  docker/atlas-local/mongod/conf/keyfile
```

Then bring the stack back up and re-run `npm run db:indexes` — search indexes live
in `mongot/data/` and are gone too.
