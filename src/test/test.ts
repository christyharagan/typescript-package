import {packageAstToFactory} from '../lib/astToFactory'
import * as fs from 'fs'
import * as m from '../lib/model'
import * as s from 'typescript-schema'

let rawPkg = packageAstToFactory('.')

let serializable = rawPkg.construct(s.factoryToSerializable())()
fs.writeFileSync('test/test.json', s.stringifyModules(serializable.modules))

let reflective = rawPkg.construct(s.factoryToReflective())()

//console.log(reflective)

export function a(){}
