"""Lists the standard-library modules the Data Editor's pandas/pyarrow need.

Run with the bundled script runtime's Python during the build (build.sh /
build.ps1). The app's server borrows pandas and pyarrow from that runtime at
run time, but standard-library modules must come from the server's own
bundle, so PyInstaller needs to know which ones to include. This exercises
every format the Data Editor reads and writes, then prints each stdlib
module that got imported, one per line.
"""
import datetime as dt
import io
import json
import os
import sys
import sysconfig

import pandas as pd
import pyarrow as pa
import pyarrow.csv as pcsv
import pyarrow.feather as feather
import pyarrow.parquet as pq

table = pa.table({
    "text": ["a", None], "n": pa.array([1, None], pa.int64()), "x": [1.5, None],
    "b": [True, None], "d": pa.array([dt.date(2026, 9, 26), None], pa.date32()),
    "t": pa.array([dt.datetime(2026, 9, 26, 14, 30), None], pa.timestamp("us")),
    "nested": pa.array([["a"], None], pa.list_(pa.string())),
})
for write, read in [
    (lambda b: pq.write_table(table, b, compression="snappy"), pq.read_table),
    (lambda b: feather.write_feather(table, b, compression="uncompressed"), feather.read_table),
]:
    buf = io.BytesIO()
    write(buf)
    buf.seek(0)
    read(buf)
csv_buf = io.BytesIO()
pcsv.write_csv(table.drop_columns(["nested"]), csv_buf)
pcsv.read_csv(io.BytesIO(csv_buf.getvalue()))
pa.Table.from_pylist(table.to_pylist())

df = pd.DataFrame({
    "i": pd.array([1, None], dtype="Int64"), "f": pd.array([1.5, None], dtype="Float64"),
    "b": pd.array([True, None], dtype="boolean"), "s": pd.array(["x", None], dtype="string"),
    "t": pd.to_datetime(["2026-09-26 14:30", None]),
})
df = pd.concat([df, df], ignore_index=True).sort_values("i", na_position="last", kind="stable")
pd.to_datetime("2026-09-26").date()
pa.array(df["i"], type=pa.int64(), from_pandas=True)
json.dumps(table.to_pylist(), default=str)

paths = sysconfig.get_paths()
stdlib_dirs = {os.path.realpath(paths["stdlib"]), os.path.realpath(paths["platstdlib"])}
for name, module in sorted(sys.modules.items()):
    if name == "__main__":
        continue
    if name in sys.builtin_module_names:
        print(name)
        continue
    file = getattr(module, "__file__", None)
    if not file:
        continue
    real = os.path.realpath(file)
    if "site-packages" in real:
        continue
    if any(real.startswith(d + os.sep) for d in stdlib_dirs):
        print(name)
