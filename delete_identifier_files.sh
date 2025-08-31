#!/bin/bash

# Script to delete all *.Identifier files recursively

echo "Finding and deleting all *.Identifier files..."

# Count files before deletion
count=$(find . -type f -name "*.Identifier" 2>/dev/null | wc -l)

if [ "$count" -eq 0 ]; then
    echo "No *.Identifier files found."
    exit 0
fi

echo "Found $count *.Identifier file(s)"
echo "Deleting..."

# Delete all *.Identifier files
find . -type f -name "*.Identifier" -delete 2>/dev/null

echo "Done! Deleted $count *.Identifier file(s)"