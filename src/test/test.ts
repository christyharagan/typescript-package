import {generateRawPackage} from '../lib/rawGenerator'
import * as fs from 'fs'
import * as m from '../lib/model'
import * as s from 'typescript-schema'

let rawPkg = generateRawPackage('.')

s.convertRawModules(rawPkg)

fs.writeFileSync('test/test.json', s.stringifyModules(rawPkg))

export function a() {}
