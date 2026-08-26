# External references used for E-04 staging guidance

1. TigerBeetle, **Deploying**: https://docs.tigerbeetle.com/operating/deploying/
   - Deployment uses one statically linked binary per replica, formats one data file per replica with cluster ID, replica count, and replica index, and starts replicas with the same ordered address list.
   - The documentation recommends six replicas for production; its three-replica example is a deployment illustration.
   - Cluster and replica arguments must match across replicas; replica indexes must be unique; address order must correspond to replica indexes.

2. TigerBeetle, **Cluster Recommendations**: https://docs.tigerbeetle.com/operating/cluster/
   - The recommended production cluster has six replicas, with four of six needed to elect a new primary after primary failure.
   - Independent fault domains and preferably three sites are recommended for mission-critical availability.

3. TigerBeetle, **Go client**: https://docs.tigerbeetle.com/coding/clients/go/
   - The Go client is constructed from a 128-bit cluster ID and the addresses of all replicas.
   - Client instances are thread-safe and support batched requests; transfer/account creation results must be checked individually.
