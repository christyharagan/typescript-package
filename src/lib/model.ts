import * as ts from 'typescript'
import * as s from 'typescript-schema'

export interface PackageJSON {
  name: string
  version: string
  description?: string
  dependencies?: { [name: string]: string }
  main?: string
  typings?: string
}

export interface TSConfigJSON {
  compilerOptions: ts.CompilerOptions
  files?: string[]
  exclude?: string[]
}
