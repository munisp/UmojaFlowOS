"""Apache Sedona aggregate-only jurisdiction job.

Run this job through the configured Livy client, never on the control-plane
web process. Input is an already redacted bronze lakehouse dataset. The job
refuses raw latitude/longitude, customer identifiers, account numbers, and
document references before it reads data. Its only geographic artefact is an
aggregate cell geometry paired with a cohort count of at least ten.
"""

from __future__ import annotations

import sys


FORBIDDEN_COLUMNS = {
    "latitude",
    "longitude",
    "geometry_raw",
    "customer_name",
    "customer_id",
    "account_number",
    "document_uri",
    "wallet_address",
}
REQUIRED_COLUMNS = {"jurisdiction", "h3_cell", "aggregate_geometry_wkt", "metric_name", "cohort_count"}


def main(input_uri: str, output_uri: str, metric_name: str, h3_resolution: str) -> None:
    from pyspark.sql import functions as F
    from sedona.spark import SedonaContext

    resolution = int(h3_resolution)
    if not 5 <= resolution <= 9:
        raise ValueError("H3 resolution must be between 5 and 9")
    if not input_uri.startswith("s3://") or not output_uri.startswith("s3://"):
        raise ValueError("input and output must be S3-compatible lakehouse URIs")

    spark = SedonaContext.create(SedonaContext.builder().appName("umojaflowos-jurisdiction-aggregate").getOrCreate())
    source = spark.read.json(input_uri)
    unexpected = FORBIDDEN_COLUMNS.intersection(source.columns)
    if unexpected:
        raise ValueError(f"raw or identifying columns are prohibited: {sorted(unexpected)}")
    missing = REQUIRED_COLUMNS - set(source.columns)
    if missing:
        raise ValueError(f"aggregate source is incomplete: {sorted(missing)}")

    aggregate = (
        source.filter(F.col("metric_name") == metric_name)
        .groupBy("jurisdiction", "h3_cell", "aggregate_geometry_wkt", "metric_name")
        .agg(F.sum(F.col("cohort_count")).alias("cohort_count"))
        .filter(F.col("cohort_count") >= 10)
        .withColumn("geometry", F.expr("ST_GeomFromWKT(aggregate_geometry_wkt)"))
        .drop("aggregate_geometry_wkt")
        .withColumn("h3_resolution", F.lit(resolution))
    )
    # The GeoJSON contains aggregate cell geometry and cohort-level measures
    # only. Apache Sedona performs both the geometry construction and output.
    aggregate.write.mode("errorifexists").format("geojson").save(output_uri)


if __name__ == "__main__":
    if len(sys.argv) != 5:
        raise SystemExit("usage: sedona_jurisdiction_aggregate.py <input-uri> <output-uri> <metric-name> <h3-resolution>")
    main(*sys.argv[1:])
