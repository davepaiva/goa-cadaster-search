# Goa Cadastral Search
[Live URL](https://davepaiva.github.io/goa-cadastral-duckdb-demo/)


This is a simple tool that allows us to search any plot in Goa via its survey number. Implemented as discussed in the GitHub issue: [Search by revenue village, plot number #78](https://github.com/publicmap/amche-atlas/issues/78).

## Background

This demo was created to explore the feasibility of using [DuckDB](https://duckdb.org/) - an in-process analytical database - to query cadastral data efficiently in the browser. The approach was suggested as an alternative to traditional database solutions for searching plot information by revenue village and plot numbers.

## Data Source

The cadastral data used in this demo is sourced from:
**[Indian Cadastrals - Goa Release](https://github.com/ramSeraph/indian_cadastrals/releases/tag/goa)**

This dataset contains cadastral information extracted from onemapgoagis and includes complete taluka and village information, making it suitable for implementing the search functionality requested in the original issue.

## Purpose

This POC demonstrates how DuckDB can be used to:
- Query parquet files using SQL syntax directly in the browser
- Enable efficient search by revenue village and plot numbers  
- Handle large cadastral datasets without requiring a backend database

## Related Links

- Original Feature Request: [publicmap/amche-atlas#78](https://github.com/publicmap/amche-atlas/issues/78)
- Data Source: [ramSeraph/indian_cadastrals](https://github.com/ramSeraph/indian_cadastrals/releases/tag/goa)
- DuckDB Documentation: [https://duckdb.org](https://duckdb.org)
