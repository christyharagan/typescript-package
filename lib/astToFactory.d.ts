import * as s from 'typescript-schema';
import * as ts from 'typescript';
import * as utils from './packageUtils';
export declare function packageAstToFactory(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost): s.PackageFactory;
export declare function moduleAstsToFactory(p: ts.Program, rootDir: string, relativePrefix?: string | utils.RelativePrefix): s.KeyValue<s.ModuleFactory>;
