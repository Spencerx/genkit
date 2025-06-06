#!/usr/bin/env python3
#
# Copyright 2025 Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# SPDX-License-Identifier: Apache-2.0


"""Standalone convenience script used to massage the typing.py.

The `genkit/typing.py` file is generated by datamodel-codegen. However, since
the tool doesn't currently provide options to generate exactly the kind of code
we need, we use this convenience script to parse the Python source code, walk
the AST, modify it to include the bits we need and regenerate the code for
eventual use within our codebase.

Transformations applied:
- We remove the model_config attribute from classes that ineherit from
  RootModel.
- We add the `populate_by_name=True` parameter to ensure serialization uses
  camelCase for attributes since the JS implementation uses camelCase and Python
  uses snake_case. The codegen pass is configured to generate snake_case for a
  Pythonic API but serialize to camelCase in order to be compatible with
  runtimes.
- We add a license header
- We add a header indicating that this file has been generated by a code
  generator pass.
- We add the ability to use forward references.
- Add docstrings if missing.
"""

import ast
import sys
from _ast import AST
from datetime import datetime
from pathlib import Path
from typing import Type, cast


class ClassTransformer(ast.NodeTransformer):
    """AST transformer that modifies class definitions."""

    def __init__(self) -> None:
        """Initialize the ClassTransformer."""
        self.modified = False

    def is_rootmodel_class(self, node: ast.ClassDef) -> bool:
        """Check if a class definition is a RootModel class."""
        for base in node.bases:
            if isinstance(base, ast.Name) and base.id == 'RootModel':
                return True
            elif isinstance(base, ast.Subscript):
                value = base.value
                if isinstance(value, ast.Name) and value.id == 'RootModel':
                    return True
        return False

    def create_model_config(self, existing_config: ast.Call | None = None) -> ast.Assign:
        """Create or update a model_config assignment.

        Ensures populate_by_name=True and extra='forbid', keeping other existing
        settings.
        """
        keywords = []
        found_populate = False

        # Preserve existing keywords if present, but override 'extra'
        if existing_config:
            for kw in existing_config.keywords:
                if kw.arg == 'populate_by_name':
                    # Ensure it's set to True
                    keywords.append(
                        ast.keyword(
                            arg='populate_by_name',
                            value=ast.Constant(value=True),
                        )
                    )
                    found_populate = True
                elif kw.arg == 'extra':
                    # Skip the existing 'extra', we will enforce 'forbid'
                    continue
                else:
                    keywords.append(kw)  # Keep other existing settings

        # Always add extra='forbid'
        keywords.append(ast.keyword(arg='extra', value=ast.Constant(value='forbid')))

        # Add populate_by_name=True if it wasn't found
        if not found_populate:
            keywords.append(ast.keyword(arg='populate_by_name', value=ast.Constant(value=True)))

        # Sort keywords for consistent output (optional but good practice)
        keywords.sort(key=lambda kw: kw.arg or '')

        return ast.Assign(
            targets=[ast.Name(id='model_config')],
            value=ast.Call(func=ast.Name(id='ConfigDict'), args=[], keywords=keywords),
        )

    def has_model_config(self, node: ast.ClassDef) -> ast.Assign | None:
        """Check if class already has model_config assignment and return it."""
        for item in node.body:
            if isinstance(item, ast.Assign):
                targets = item.targets
                if len(targets) == 1 and isinstance(targets[0], ast.Name):
                    if targets[0].id == 'model_config':
                        return item
        return None

    def visit_ClassDef(self, _node: ast.ClassDef) -> ast.ClassDef:  # noqa: N802
        """Visit and transform a class definition node.

        Args:
            node: The ClassDef AST node to transform.

        Returns:
            The transformed ClassDef node.
        """
        # First apply base class transformations recursively
        node = super().generic_visit(_node)
        new_body: list[ast.stmt | ast.Constant | ast.Assign] = []

        # Handle Docstrings
        if not node.body or not isinstance(node.body[0], ast.Expr) or not isinstance(node.body[0].value, ast.Constant):
            # Generate a more descriptive docstring based on class type
            if self.is_rootmodel_class(node):
                docstring = f'Root model for {node.name.lower().replace("_", " ")}.'
            elif any(isinstance(base, ast.Name) and base.id == 'BaseModel' for base in node.bases):
                docstring = f'Model for {node.name.lower().replace("_", " ")} data.'
            elif any(isinstance(base, ast.Name) and base.id == 'Enum' for base in node.bases):
                n = node.name.lower().replace('_', ' ')
                docstring = f'Enumeration of {n} values.'
            else:
                docstring = f'{node.name} data type class.'

            new_body.append(ast.Expr(value=ast.Constant(value=docstring)))
            self.modified = True
        else:  # Ensure existing docstring is kept
            new_body.append(node.body[0])

        # Handle model_config for BaseModel and RootModel
        existing_model_config_assign = self.has_model_config(node)
        existing_model_config_call = None
        if existing_model_config_assign and isinstance(existing_model_config_assign.value, ast.Call):
            existing_model_config_call = existing_model_config_assign.value

        # Determine start index for iterating original body (skip docstring)
        body_start_index = (
            1 if (node.body and isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Str)) else 0
        )

        if self.is_rootmodel_class(node):
            # Remove model_config from RootModel classes
            for stmt in node.body[body_start_index:]:
                # Skip existing model_config
                if isinstance(stmt, ast.Assign) and any(
                    isinstance(target, ast.Name) and target.id == 'model_config' for target in stmt.targets
                ):
                    self.modified = True  # Mark modified even if removing
                    continue
                new_body.append(stmt)
        elif any(isinstance(base, ast.Name) and base.id == 'BaseModel' for base in node.bases):
            # Add or update model_config for BaseModel classes
            added_config = False
            for stmt in node.body[body_start_index:]:
                if isinstance(stmt, ast.Assign) and any(
                    isinstance(target, ast.Name) and target.id == 'model_config' for target in stmt.targets
                ):
                    # Update existing model_config
                    updated_config = self.create_model_config(existing_model_config_call)
                    # Check if the config actually changed
                    if ast.dump(updated_config) != ast.dump(stmt):
                        new_body.append(updated_config)
                        self.modified = True
                    else:
                        new_body.append(stmt)  # No change needed
                    added_config = True
                else:
                    new_body.append(stmt)

            if not added_config:
                # Add model_config if it wasn't present
                # Insert after potential docstring
                insert_pos = 1 if len(new_body) > 0 and isinstance(new_body[0], ast.Expr) else 0
                new_body.insert(insert_pos, self.create_model_config())
                self.modified = True
        elif any(isinstance(base, ast.Name) and base.id == 'Enum' for base in node.bases):
            # Uppercase Enum members
            for stmt in node.body[body_start_index:]:
                if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
                    target_name = stmt.targets[0].id
                    uppercase_name = target_name.upper()
                    if target_name != uppercase_name:
                        stmt.targets[0].id = uppercase_name
                        self.modified = True
                new_body.append(stmt)
        else:
            # For other classes, just copy the rest of the body
            new_body.extend(node.body[body_start_index:])

        node.body = cast(list[ast.stmt], new_body)
        return node


def add_header(content: str) -> str:
    """Add the generated header to the content."""
    header = '''# Copyright {year} Google LLC
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
#
# SPDX-License-Identifier: Apache-2.0
#
# DO NOT EDIT: Generated by `generate_schema_typing` from `genkit-schemas.json`.

"""Schema types module defining the core data models for Genkit.

This module contains Pydantic models that define the structure and validation
for various data types used throughout the Genkit framework, including messages,
actions, tools, and configuration options.
"""

'''
    # Ensure there's exactly one newline between header and content
    # and future import is right after the header block's closing quotes.
    future_import = 'from __future__ import annotations'
    str_enum_block = """
import sys # noqa

if sys.version_info < (3, 11):  # noqa
    from strenum import StrEnum  # noqa
else: # noqa
    from enum import StrEnum  # noqa
"""

    header_text = header.format(year=datetime.now().year)

    # Remove existing future import and StrEnum import from content.
    lines = content.splitlines()
    filtered_lines = [
        line for line in lines if line.strip() != future_import and line.strip() != 'from enum import StrEnum'
    ]
    cleaned_content = '\n'.join(filtered_lines)

    final_output = header_text + future_import + '\n' + str_enum_block + '\n\n' + cleaned_content
    if not final_output.endswith('\n'):
        final_output += '\n'
    return final_output


def process_file(filename: str) -> None:
    """Process a Python file to remove model_config from RootModel classes.

    This function reads a Python file, processes its AST to remove model_config
    from RootModel classes, and writes the modified code back to the file.

    Args:
        filename: Path to the Python file to process.

    Raises:
        FileNotFoundError: If the input file does not exist.
        SyntaxError: If the input file contains invalid Python syntax.
    """
    path = Path(filename)
    if not path.is_file():
        print(f'Error: File not found: {filename}')
        sys.exit(1)

    try:
        with open(path, encoding='utf-8') as f:
            source = f.read()

        tree = ast.parse(source)
        class_transformer = ClassTransformer()
        modified_tree = class_transformer.visit(tree)

        # Generate source from potentially modified AST
        ast.fix_missing_locations(modified_tree)
        modified_source_no_header = ast.unparse(modified_tree)

        # Add header and specific imports correctly
        final_source = add_header(modified_source_no_header)

        # Write back only if content has changed (header or AST)
        if final_source != source:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(final_source)
            print(f'Successfully processed and updated {filename}')
        else:
            print(f'No changes needed for {filename}')

    except SyntaxError as e:
        print(f'Error: Invalid Python syntax in {filename}: {e}')
        sys.exit(1)


def main() -> None:
    """Main entry point for the script.

    This function processes command line arguments and calls the appropriate
    functions to process the schema types file.

    Usage:
        python script.py <filename>
    """
    if len(sys.argv) != 2:
        print('Usage: python script.py <filename>')
        sys.exit(1)

    process_file(sys.argv[1])


if __name__ == '__main__':
    main()
