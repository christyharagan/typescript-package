TypeScript Package Library
==

Overview
--

A convenience library for generating typescript-schema reflective models from typescript code.

Also provides some useful functions for reading various metadata files like tsconfig.json and package.json

Usage
--

Install:
```
npm install typescript-package
```

Basic Usage:

```TypeScript
import * as p from 'typescript-package'

// Create a raw model from some typescript files
let modules = p.generateRawPackage('/myPkgDir/')

// Pass this to typescript-schema to convert to a resolved model
```
