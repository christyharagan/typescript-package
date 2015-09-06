import * as path from 'path'
import * as fs from 'fs'
import * as s from 'typescript-schema'
import * as ts from 'typescript'
import * as utils from './packageUtils'
import * as g from './rawGenerator'

export function writePackageSchema(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost, schemaPath?: string): s.Map<s.Module> {
  schemaPath = path.join(pkgDir, schemaPath || 'packageSchema.json')
  let pkgName = utils.getPackageJson(pkgDir).name
  let rawPackage = g.generateRawPackage(pkgDir, options, host)
  let rawSchema = s.filterRawModules((moduleName: string) => moduleName.indexOf(pkgName) === 0, rawPackage)
  fs.writeFileSync(schemaPath, s.stringifyModules(rawSchema))
  return s.convertRawModules(rawSchema)
}

export function readPackageSchema(pkgDir: string, schemaPath?: string): s.Map<s.Module> {
  schemaPath = path.join(pkgDir, schemaPath || 'packageSchema.json')
  return s.convertRawModules(<s.Map<s.RawTypeContainer>>s.parseModules(fs.readFileSync(schemaPath).toString()))
}
