import * as ts from 'typescript';
export interface PackageJSON {
    name: string;
    dependencies: {
        [name: string]: string;
    };
    main?: string;
}
export interface TSConfigJSON {
    compilerOptions: ts.CompilerOptions;
    files: string[];
}