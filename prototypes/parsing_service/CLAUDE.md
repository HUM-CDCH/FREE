# Parsing Service

Read `README.md` for the current service boundary and runtime contract. Keep
all task-file resolution behind `TaskStorage`; external task identifiers must
pass canonical UUID validation before becoming paths.
