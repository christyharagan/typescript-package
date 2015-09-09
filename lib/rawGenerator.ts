import * as m from './model'
import * as s from 'typescript-schema'
import * as ts from 'typescript'
import * as path from 'path'
import * as fs from 'fs'
import * as utils from './packageUtils'

export function generateRawPackage(pkgDir: string, options?: ts.CompilerOptions, host?: ts.CompilerHost): s.Map<s.RawTypeContainer> {
  let allRawModules: s.Map<s.RawTypeContainer> = {}

  let packageJson = utils.getPackageJson(pkgDir)
  let files = utils.getSourceFilesList(pkgDir)
  files = loadAllFiles(files)

  let pkgs: s.Map<[string, string]> = {}
  let p = ts.createProgram(files, options || { target: ts.ScriptTarget.ES5 }, host)

  p.getSourceFiles().forEach(function(sf) {
    let file = sf.fileName
    let dirName = path.dirname(file)
    while (true) {
      if (fs.existsSync(path.join(dirName, 'package.json'))) {
        let pkgJson = <m.PackageJSON>JSON.parse(fs.readFileSync(path.join(dirName, 'package.json')).toString())
        pkgs[file] = [pkgJson.name, path.relative(pkgDir, dirName).replace(/\\/g, '/')]
        break
      } else {
        dirName = path.dirname(dirName)
      }
      if (dirName === path.join(dirName, '..')) {
        throw new Error('Package not found for file: ' + file)
      }
    }
  })

  function relativePrefix(fileName: string, moduleName: string) {
    let pkg = pkgs[fileName]
    return path.posix.join(pkg[0], path.posix.relative(pkg[1], moduleName))
  }

  return generateRawModules(p, pkgDir, relativePrefix)
}

export function generateRawModules(p: ts.Program, rootDir: string, relativePrefix?: string|utils.RelativePrefix): s.Map<s.RawTypeContainer> {
  let modules: s.Map<s.RawTypeContainer> = {}
  let globals = getGlobals(p)
  let tc = p.getTypeChecker()

  p.getSourceFiles().forEach(sf => {
    processSourceFile(sf)
  })

  function processSourceFile(sf: ts.SourceFile): string[] {
    let moduleNames: string[] = []
    let isModule = false
    ts.forEachChild(sf, function(node) {
      if (isExported(node) || node.kind === ts.SyntaxKind.ExportDeclaration) {
        isModule = true
      }
    })
    if (isModule) {
      let moduleName = utils.fileNameToModuleName(sf.fileName, rootDir, relativePrefix)
      modules[moduleName] = processModule(moduleName, sf)
      moduleNames.push(moduleName)
    } else {
      moduleNames = moduleNames.concat(processDeclarationFile(sf))
    }

    return moduleNames
  }

  function processModule(moduleName: string, moduleNode: ts.Node, module?: s.RawTypeContainer, isDeclared?: boolean): s.RawTypeContainer {
    if (!module) {
      module = createRawTypeContainer()
    }

    processTypeContainer(moduleName, module, moduleNode, isDeclared)

    return module
  }

  function processDeclarationFile(declarationFile: ts.SourceFile): string[] {
    let globalModule = modules['']
    if (!globalModule) {
      globalModule = createRawTypeContainer()
      modules[''] = globalModule
    }
    return processTypeContainer('', globalModule, declarationFile, true)
  }

  function processExport(typeContainer: s.RawTypeContainer, node: ts.Node) {
    switch (node.kind) {
      case ts.SyntaxKind.VariableStatement:
        let vars = <ts.VariableStatement>node
        let valueKind: s.ValueKind = vars.declarationList.flags === ts.NodeFlags.Const ? s.ValueKind.CONST : (vars.declarationList.flags === ts.NodeFlags.Let ? s.ValueKind.LET : s.ValueKind.VAR)
        vars.declarationList.declarations.forEach(function(varDec) {
          let name = getName(varDec.name)
          if (Array.isArray(name)) {
            // TODO
          } else {
            typeContainer.statics[name] = {
              valueKind: valueKind,
              type: processType(tc.getTypeAtLocation(varDec))
            }
            if (varDec.initializer) {
              typeContainer.statics[name].initialiser = processExpression(varDec.initializer)
            }
          }
        })
        break
      case ts.SyntaxKind.InterfaceDeclaration:
        populateInterface(<ts.InterfaceDeclaration>node, typeContainer)
        break
      case ts.SyntaxKind.ClassDeclaration:
        populateClass(typeContainer, <ts.ClassDeclaration>node)
        break
      case ts.SyntaxKind.EnumDeclaration:
        let enumDec = <ts.EnumDeclaration>node
        typeContainer.types[enumDec.name.text] = <s.RawEnumType>{
          typeKind: s.TypeKind.ENUM,
          members: enumDec.members.map(function(member) {
            let enumMember: s.RawEnumMember = {
              name: <string>getName(member.name)
            }
            if (member.initializer) {
              enumMember.initialiser = processExpression(member.initializer)
            }

            return enumMember
          })
        }
        break
      case ts.SyntaxKind.TypeAliasDeclaration:
        populateAlias(typeContainer, <ts.TypeAliasDeclaration>node)
        break
      case ts.SyntaxKind.FunctionDeclaration:
        let func = <ts.FunctionDeclaration>node
        typeContainer.statics[func.name.text] = {
          valueKind: s.ValueKind.FUNCTION,
          type: processSignatureType(func)
        }
        break
    }
  }

  function processSymbolTable(typeContainerName: string, typeContainer: s.RawTypeContainer, symbolTable: ts.SymbolTable) {
    Object.keys(symbolTable).forEach(function(name) {
      let symbol = symbolTable[name]
      // It can be, when the export is a class that the prototype export is in the symbol table, but it has no declarations.
      // Need a proper fix to this scenario
      if (symbol && symbol.declarations) {
        symbol.declarations.forEach(function(dec) {
          if (dec.kind === ts.SyntaxKind.ExportDeclaration) {
            let exportDec = <ts.ExportDeclaration>dec
            processSymbolTable(typeContainerName + ':' + name, typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports)
          } else if (dec.kind === ts.SyntaxKind.ExportAssignment) {
            // TODO: There seems to be a change between v1.5 and v1.6/v1.7. This is duplicated code with processTypeContainer
            // Copying here so all versions work, but this requires a proper investigation

            // TODO: This is not a complete solution
            let exportAssignment = <ts.ExportAssignment>dec
            let exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression)
            let exportType = tc.getTypeAtLocation(exportAssignment.expression)

            if (exportType && exportType.symbol && exportType.symbol.exports) {
              // TODO: There is a funky thing when the export is a class and a module (a la the Twitter typings)
              // E.g; declare class Twitter{} declare module Twitter{}
              processSymbolTable(typeContainerName, typeContainer, exportType.symbol.exports || exportType.symbol.members)
            } else if (exportSymbol.exports) {
              processSymbolTable(typeContainerName, typeContainer, exportSymbol.exports)
            } else {
              let importDec = <ts.ImportEqualsDeclaration>exportSymbol.declarations[0]
              processSymbolTable(typeContainerName, typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members)
            }
          } else {
            // TODO: How do we handle call signatures as exports?
            if (dec.kind !== ts.SyntaxKind.CallSignature) {
              let ref = getReference(dec, dec.kind === ts.SyntaxKind.ModuleDeclaration)
              if (ref.module !== typeContainerName) {
                typeContainer.reexports[name] = ref
              }
            }
          }
        })
      }
    })
  }

  function processTypeContainer(typeContainerName: string, typeContainer: s.RawTypeContainer, node: ts.Node, isDeclaredModule: boolean): string[] {
    let moduleNames: string[] = []
    ts.forEachChild(node, function(child: ts.Node) {
      switch (child.kind) {
        case ts.SyntaxKind.ExportAssignment:
          // TODO: This is not a complete solution
          let exportAssignment = <ts.ExportAssignment>child
          let exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression)
          let exportType = tc.getTypeAtLocation(exportAssignment.expression)

          if (exportType && exportType.symbol && exportType.symbol.exports) {
            // TODO: There is a funky thing when the export is a class and a module (a la the Twitter typings)
            // E.g; declare class Twitter{} declare module Twitter{}
            processSymbolTable(typeContainerName, typeContainer, exportType.symbol.exports || exportType.symbol.members)
          } else if (exportSymbol.exports) {
            processSymbolTable(typeContainerName, typeContainer, exportSymbol.exports)
          } else {
            let importDec = <ts.ImportEqualsDeclaration>exportSymbol.declarations[0]
            processSymbolTable(typeContainerName, typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members)
          }
          break
        case ts.SyntaxKind.ExportDeclaration:
          let exportDec = <ts.ExportDeclaration>child
          let exportClause = exportDec.exportClause
          if (exportClause) {
            let moduleName = getReference(tc.getSymbolAtLocation(exportDec.moduleSpecifier), true).module
            exportDec.exportClause.elements.forEach(function(element) {
              if (element.propertyName) {
                typeContainer.reexports[element.name.text] = {
                  module: moduleName,
                  name: element.propertyName.text
                }
              } else {
                typeContainer.reexports[element.name.text] = {
                  module: moduleName,
                  name: element.name.text
                }
              }
            })
          }
          processSymbolTable(typeContainerName, typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports || tc.getSymbolAtLocation(exportDec.moduleSpecifier).members)
          break
        default:
          if (isDeclaredModule || modules[''] === typeContainer || isExported(child)) {
            switch (child.kind) {
              case ts.SyntaxKind.ModuleDeclaration:
                let modDec = <ts.ModuleDeclaration>child
                let name = (<ts.StringLiteral>modDec.name).text
                let symbol = tc.getTypeAtLocation(modDec).symbol
                if (modules[''] === typeContainer && symbol && (symbol.name.charAt(0) === '"' || symbol.name.charAt(0) === '\'')) {
                  ts.forEachChild(modDec, function(child) {
                    if (child.kind === ts.SyntaxKind.ModuleBlock) {
                      modules[name] = processModule(name, child, modules[name], true)
                      moduleNames.push(name)
                    }
                  })
                } else {
                  let namespace = typeContainer.namespaces[name] || createRawTypeContainer()
                  typeContainer.namespaces[name] = namespace
                  ts.forEachChild(modDec, function(child) {
                    if (child.kind === ts.SyntaxKind.ModuleBlock) {
                      processTypeContainer(typeContainerName + ':' + name, namespace, child, isDeclaredModule)
                    }
                  })
                }
                break
              default:
                processExport(typeContainer, child)
            }
          }
      }
    })
    return moduleNames
  }

  function getReference(symbolOrDec: ts.Symbol|ts.Declaration, isModule: boolean): s.Reference {
    let moduleName: string

    let isGlobal: boolean = false
    let dec: ts.Declaration
    let name: string
    if ((<ts.Declaration>symbolOrDec).kind) {
      dec = <ts.Declaration>symbolOrDec
      name = <string>getName(dec.name)
      let globalSymbol = globals.types[name]
      isGlobal = !isModule && globalSymbol && globalSymbol.declarations[0] === dec
    } else {
      let symbol = <ts.Symbol>symbolOrDec
      dec = symbol.declarations[0]
      name = symbol.name

      // ************** DON'T DELETE ******************

      // TODO: Finish this: This is the start of implementing deeply nested properties
      // if (dec.kind === ts.SyntaxKind.PropertyAssignment) {
      //   let pa = <ts.PropertyAssignment>dec
      //   while (pa) {
      //     let grandParent = pa.parent.parent
      //     if (grandParent.kind === ts.SyntaxKind.PropertyAssignment) {
      //       pa = <ts.PropertyAssignment>grandParent
      //       name = getName(pa.name) + '.' + name
      //     } else {
      //       if (grandParent.kind === ts.SyntaxKind.VariableDeclaration) {
      //         let va = <ts.VariableDeclaration>grandParent
      //         name = getName(va.name) + '.' + name
      //       }
      //       pa = null
      //     }
      //   }
      // }

      isGlobal = !isModule && globals.types[name] === symbol
    }

    if (isGlobal) {
      moduleName = ''
    } else {
      let name = ''

      let node: ts.Node = isModule ? dec : dec.parent
      while (node.kind !== ts.SyntaxKind.SourceFile) {
        switch (node.kind) {
          case ts.SyntaxKind.ModuleDeclaration:
            let mod = <ts.ModuleDeclaration>node
            name = mod.name.text + (name === '' ? '' : (':' + name))
            if (node.parent.kind === ts.SyntaxKind.SourceFile && globals.modules[mod.name.text]) {
              moduleName = name
              break
            }
        }
        node = node.parent
      }
      if (moduleName) {
        if (relativePrefix && moduleName.substring(0, 2) === './') {
          if ((<string>relativePrefix).charAt) {
            moduleName = path.posix.join(relativePrefix, moduleName)
          } else {
            moduleName = (<utils.RelativePrefix>relativePrefix)((<ts.SourceFile>node).fileName, moduleName)
          }
        }
      } else if ((<ts.SourceFile>node).fileName.substring((<ts.SourceFile>node).fileName.length - 8) === 'lib.d.ts') {
        moduleName = ''
      } else {
        moduleName = utils.fileNameToModuleName((<ts.SourceFile>node).fileName, rootDir, relativePrefix) + (name === '' ? '' : (':' + name))
      }
    }

    let reference: s.Reference = {
      module: moduleName
    }
    if (!isModule) {
      reference.name = name
    }

    return reference
  }

  function processTypeNode(node: ts.Node, typeNode?: ts.Node): s.RawType {
    let isTypeQuery = (typeNode && typeNode.kind === ts.SyntaxKind.TypeQuery) || node.kind === ts.SyntaxKind.TypeQuery
    let type: s.RawType
    if (isTypeQuery) {
      let typeSymbol = tc.getSymbolAtLocation(typeNode || node)
      if (!typeSymbol) {
        return <s.RawTypeQuery>{
          typeKind: s.TypeKind.TYPE_QUERY
        }
      } else {
        let typeSymbolDec = typeSymbol.declarations[0]
        let ref: s.Reference
        switch (typeSymbolDec.kind) {
          case ts.SyntaxKind.ModuleDeclaration:
            return getReference(typeSymbol, true)
          case ts.SyntaxKind.VariableDeclaration:
          case ts.SyntaxKind.FunctionDeclaration:
            ref = getReference(typeSymbol, false)
          default:
            let type = tc.getTypeAtLocation(typeNode || node)
            if (!type.symbol) {
              ref = getReference(tc.getSymbolAtLocation(typeNode || node), false)
            } else {
              ref = <s.Reference>processType(type)
            }
        }
        return <s.RawTypeQuery>{
          typeKind: s.TypeKind.TYPE_QUERY,
          type: ref
        }
      }
    } else {
      let type = tc.getTypeAtLocation(typeNode || node)
      if ((<ts.GenericType>type).typeParameters) {
        let typeArgNode = (typeNode || node).kind === ts.SyntaxKind.Identifier ? (typeNode || node).parent : (typeNode || node)
        if (typeArgNode.kind === ts.SyntaxKind.ArrayType) {
          let arrayType = <ts.ArrayTypeNode>typeArgNode
          return <s.RefinedReference>{
            reference: {
              module: '',
              name: 'Array'
            },
            typeArguments: [processTypeNode(arrayType.elementType)]
          }
        } else {
          let typeArguments = (<ts.TypeReferenceNode|ts.ExpressionWithTypeArguments>typeArgNode).typeArguments
          let reference: s.Reference
          if (!type.symbol && tc.getSymbolAtLocation(typeNode || node)) {
            reference = getReference(tc.getSymbolAtLocation(typeNode || node), false)
          } else {
            reference = <s.Reference>processType(type)
          }
          return <s.RefinedReference>{
            reference: reference,
            typeArguments: typeArguments.map(function(typeArg) {
              return processTypeNode(typeArg)
            })
          }
        }
      } else if (!type.symbol && tc.getSymbolAtLocation(typeNode || node)) {
        return getReference(tc.getSymbolAtLocation(typeNode || node), false)
      } else {
        return processType(type)
      }
    }
  }

  function processType(type: ts.Type): s.RawType {
    switch (type.flags) {
      case ts.TypeFlags.Any:
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.ANY
        }
      case ts.TypeFlags.String:
      case ts.TypeFlags.StringLiteral:
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.STRING
        }
      case ts.TypeFlags.Number:
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.NUMBER
        }
      case ts.TypeFlags.Boolean:
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.BOOLEAN
        }
      case ts.TypeFlags.Void:
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.VOID
        }
      //TODO: Support ES6 Symbols
      case ts.TypeFlags.ESSymbol:
        // TODO: This is just a temporary hack to make it work...
        return <s.RawPrimitiveType>{
          typeKind: s.TypeKind.PRIMITIVE,
          primitiveTypeKind: s.PrimitiveTypeKind.ANY
        }
      case ts.TypeFlags.Enum:
      case ts.TypeFlags.Class:
      case ts.TypeFlags.Interface:
      case ts.TypeFlags.Reference + ts.TypeFlags.Class:
      case ts.TypeFlags.Reference + ts.TypeFlags.Interface:
        return getReference(type.symbol, false)
      case ts.TypeFlags.TypeParameter:
        return <s.Reference>{
          module: '@',
          name: type.symbol.name
        }
      case ts.TypeFlags.Tuple:
        let tupleType = <ts.TupleType>type
        return <s.RawTupleType>{
          typeKind: s.TypeKind.TUPLE,
          elements: tupleType.elementTypes.map(processType)
        }
        tupleType.elementTypes
      case ts.TypeFlags.Union:
        let unionType = <ts.UnionType>type
        return <s.RawUnionType>{
          typeKind: s.TypeKind.UNION,
          types: unionType.types.map(processType)
        }
      case ts.TypeFlags.Reference:
      case (ts.TypeFlags.Reference + ts.TypeFlags.Interface):
        let referenceType = <ts.TypeReference>type
        return getReference(referenceType.target.symbol, false)
      case ts.TypeFlags.Anonymous:
        let declaration = type.symbol.declarations[0]
        switch (declaration.kind) {
          case ts.SyntaxKind.FunctionDeclaration:
            return getReference(<ts.FunctionLikeDeclaration>declaration, false)
          case ts.SyntaxKind.FunctionExpression:
          case ts.SyntaxKind.FunctionType:
          case ts.SyntaxKind.MethodSignature:
          case ts.SyntaxKind.MethodDeclaration:
            return processSignatureType(<ts.FunctionLikeDeclaration>declaration)
          case ts.SyntaxKind.ClassDeclaration:
          case ts.SyntaxKind.Constructor:
            return getReference(type.symbol, false)
          case ts.SyntaxKind.ObjectLiteralExpression:
            // TODO
            return s.ANY
          case ts.SyntaxKind.TypeLiteral:
            let typeLiteral = <ts.TypeLiteralNode>declaration
            let compositeType: s.RawCompositeType = {
              typeKind: s.TypeKind.COMPOSITE,
              members: {}
            }
            populateMembers(compositeType, typeLiteral.members)
            return compositeType
          case ts.SyntaxKind.ModuleDeclaration:
            return getReference(type.symbol, true)
          default:
          // TODO
        }
        break
      default:
        throw new Error('Unrecognised Type: ' + type.flags)
      // TODO: Finish
    }
  }

  function processSignatureType(declaration: ts.SignatureDeclaration): s.RawFunctionType {
    let typeParameters: s.RawTypeParameter[] = []
    if (declaration.typeParameters) {
      declaration.typeParameters.forEach(function(typeParameter) {
        typeParameters.push({ name: typeParameter.name.text })
      })
    }

    let params: Array<s.RawParameter> = declaration.parameters.map(function(paramDec: ts.ParameterDeclaration) {
      let parameter: s.RawParameter = {
        name: (<ts.Identifier>paramDec.name).text,
        type: processTypeNode(paramDec, paramDec.type)
      }
      if (paramDec.questionToken) {
        parameter.optional = true
      }
      if (paramDec.initializer) {
        parameter.initialiser = processExpression(paramDec.initializer)
      }

      processDecorators(paramDec, parameter)

      return parameter
    })

    let rawFunctionType: s.RawFunctionType = {
      typeKind: s.TypeKind.FUNCTION,
      parameters: params,
      type: (!declaration.type || declaration.type.kind === ts.SyntaxKind.VoidKeyword) ? undefined : processTypeNode(declaration.type)
    }
    if (typeParameters.length > 0) {
      rawFunctionType.typeParameters = typeParameters
    }

    return rawFunctionType
  }

  function populateMembers(parent: s.RawCompositeType, nodes: ts.NodeArray<ts.Node>) {
    nodes.forEach(function(node) {
      switch (node.kind) {
        case ts.SyntaxKind.IndexSignature:
          let index = <ts.IndexSignatureDeclaration>node
          parent.index = {
            keyType: <s.PrimitiveType>processTypeNode(index.parameters[0], index.parameters[0].type),
            valueType: processTypeNode(index.type)
          }
          break
        case ts.SyntaxKind.ConstructSignature:
          // TODO: Handle
          break
        case ts.SyntaxKind.CallSignature:
          if (!parent.calls) {
            parent.calls = []
          }
          parent.calls.push(processSignatureType(<ts.SignatureDeclaration>node))
          break
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.PropertySignature:
          let p = <ts.PropertyDeclaration>node
          let propName = <string>getName(p.name)
          parent.members[propName] = {
            optional: !!p.questionToken,
            type: processTypeNode(p)
          }
          break
        default:
          let declaration = <ts.Declaration>node
          let name = <string>getName(declaration.name)
          parent.members[name] = {
            type: processTypeNode(node)
          }
      }
    })
  }

  function populateInterface(intDec: ts.InterfaceDeclaration, parent: s.RawTypeContainer) {
    let intName = intDec.name.text

    let int = parent.interfaceConstructors[intName]
    let instanceType: s.RawDecoratedCompositeType

    if (int) {
      instanceType = int.instanceType
    } else {
      instanceType = {
        typeKind: s.TypeKind.COMPOSITE,
        members: {}
      }
      int = {
        instanceType: instanceType
      }
      parent.interfaceConstructors[intName] = int
    }

    if (intDec.heritageClauses) {
      intDec.heritageClauses.forEach(function(heritageClause: ts.HeritageClause) {
        if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
          int.extends = processHeritageClause(heritageClause)
        }
      })
    }

    int.typeParameters = processTypeParameters(parent, intDec.typeParameters)

    populateMembers(instanceType, intDec.members)

    return int
  }

  function populateClass(parent: s.RawTypeContainer, clsDec: ts.ClassDeclaration) {
    let name = clsDec.name.text

    let cls: s.RawClassConstructor = parent.classConstructors[name]
    let instanceType: s.RawDecoratedCompositeType
    let staticType: s.RawDecoratedCompositeType

    if (cls) {
      instanceType = cls.instanceType
      staticType = cls.staticType
    } else {
      instanceType = {
        typeKind: s.TypeKind.COMPOSITE,
        members: {}
      }
      staticType = {
        typeKind: s.TypeKind.COMPOSITE,
        members: {},
        calls: []
      }
      cls = {
        instanceType: instanceType,
        staticType: staticType
      }
      parent.classConstructors[name] = cls
    }

    processDecorators(clsDec, cls)

    if (clsDec.heritageClauses) {
      clsDec.heritageClauses.forEach(function(heritageClause: ts.HeritageClause) {
        if (heritageClause.token === ts.SyntaxKind.ImplementsKeyword) {
          cls.implements = processHeritageClause(heritageClause)
        } else if (heritageClause.token === ts.SyntaxKind.ExtendsKeyword) {
          cls.extends = processHeritageClause(heritageClause)[0]
        }
      })
    }
    if (clsDec.typeParameters) {
      cls.typeParameters = processTypeParameters(parent, clsDec.typeParameters)
    }

    clsDec.members.forEach(function(member: ts.ClassElement) {
      let name: string
      let type: s.RawType

      switch (member.kind) {
        case ts.SyntaxKind.IndexSignature:
          let index = <ts.IndexSignatureDeclaration>member
          instanceType.index = {
            keyType: <s.PrimitiveType>processTypeNode(index.parameters[0].type),
            valueType: processTypeNode(index.type)
          }
          break
        case ts.SyntaxKind.Constructor:
          let constructorDec = <ts.ConstructorDeclaration>member
          staticType.calls.push(processSignatureType(constructorDec))
          break
        case ts.SyntaxKind.MethodDeclaration:
        case ts.SyntaxKind.PropertyDeclaration:
        case ts.SyntaxKind.GetAccessor:
          let methodDec = <ts.MethodDeclaration|ts.PropertyDeclaration|ts.AccessorDeclaration>member
          name = (<ts.Identifier>methodDec.name).text
          type = processTypeNode(methodDec)
          break
      }

      if (name && type) {
        let classMember: s.RawDecoratedMember = {
          type: type
        }
        processDecorators(member, classMember)

        instanceType.members[name] = classMember
      }
    })

    return cls
  }

  function populateAlias(parent: s.RawTypeContainer, aliasDec: ts.TypeAliasDeclaration) {
    parent.types[aliasDec.name.text] = {
      typeKind: s.TypeKind.TYPE_ALIAS,
      type: processTypeNode(aliasDec.type)
    }
  }

  function processHeritageClause(heritageClause: ts.HeritageClause): (s.Reference|s.RefinedReference)[] {
    return heritageClause.types.map(function(heritageClauseElement: ts.ExpressionWithTypeArguments) {
      let heritageType = processTypeNode(heritageClauseElement.expression)
      if ((<s.TypeTemplate>heritageType).typeKind) {
        throw new Error('Reference not found: ' + heritageClauseElement.expression.getText() + ' for constructor ' + (<ts.InterfaceDeclaration>heritageClause.parent).name.text)
      }
      return <s.Reference>heritageType
    })
  }

  function processTypeParameters(parent: s.RawTypeContainer, typeParameters: ts.TypeParameterDeclaration[]): s.RawTypeParameter[] {
    if (typeParameters) {
      return typeParameters.map(function(typeParameter: ts.TypeParameterDeclaration) {
        let typeParameterSchema: s.RawTypeParameter = {
          name: typeParameter.name.text
        }
        if (typeParameter.constraint) {
          typeParameterSchema.extends = processTypeNode(typeParameter.constraint)
        }
        return typeParameterSchema
      })
    }
  }

  function processExpression(expression: ts.Expression): s.RawExpression {
    switch (expression.kind) {
      case ts.SyntaxKind.Identifier:
        let cls = processTypeNode(expression)
        return <s.RawClassExpression>{
          expressionKind: s.ExpressionKind.CLASS,
          class: processTypeNode(expression)
        }
      case ts.SyntaxKind.StringLiteral:
        return <s.RawLiteralExpression<string>>{
          expressionKind: s.ExpressionKind.STRING,
          value: (<ts.LiteralExpression>expression).text
        }
      case ts.SyntaxKind.TrueKeyword:
        return <s.RawLiteralExpression<boolean>>{
          expressionKind: s.ExpressionKind.BOOLEAN,
          value: true
        }
      case ts.SyntaxKind.FalseKeyword:
        return <s.RawLiteralExpression<boolean>>{
          expressionKind: s.ExpressionKind.BOOLEAN,
          value: false
        }
      case ts.SyntaxKind.NumericLiteral:
        return <s.RawLiteralExpression<number>>{
          expressionKind: s.ExpressionKind.NUMBER,
          value: parseFloat((<ts.LiteralExpression>expression).text)
        }
      case ts.SyntaxKind.ObjectLiteralExpression:
        let object: s.RawObjectExpression = {
          expressionKind: s.ExpressionKind.OBJECT,
          properties: {
          }
        }
        let objectLiteral = <ts.ObjectLiteralExpression>expression
        objectLiteral.properties.forEach(function(property) {
          let name = (<ts.Identifier>property.name).text
          let assignment = (<ts.PropertyAssignment>property).initializer
          object.properties[name] = processExpression(assignment)
        })
        return object
      case ts.SyntaxKind.ArrayLiteralExpression:
        let array: s.RawArrayExpression = {
          expressionKind: s.ExpressionKind.ARRAY,
          elements: []
        }
        let arrayLiteral = <ts.ArrayLiteralExpression>expression
        arrayLiteral.elements.forEach(function(element) {
          array.elements.push(processExpression(element))
        })
        return array
      case ts.SyntaxKind.PropertyAccessExpression:
        let pae = <ts.PropertyAccessExpression>expression
        let name = pae.name.getText()
        if (name) {
          let type = <s.Reference>processTypeNode(pae.name)
          if (type.name && type.name !== name) {
            // TODO: This is a quick fix to get enums working in expressions.. This requires a full implementation
            return <s.RawEnumExpression>{
              enum: type,
              value: name,
              expressionKind: s.ExpressionKind.ENUM
            }
          }
        }
      default:
        return <s.RawComplexExpression>{
          expressionKind: s.ExpressionKind.COMPLEX,
          type: processTypeNode(expression)
        }
    }
  }

  function processDecorators(node: ts.Node, schema: s.RawDecorated) {
    schema.decorators = []
    if (node.decorators) {
      node.decorators.forEach(function(decorator: ts.Decorator) {
        if (decorator.expression.kind === ts.SyntaxKind.Identifier) {
          let id = <ts.Identifier>decorator.expression
          let decoratorType = processTypeNode(id)
          if ((<s.TypeTemplate>decoratorType).typeKind) {
            throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText())
          }
          schema.decorators.push({
            decoratorType: <s.Reference>decoratorType
          })
        } else if (decorator.expression.kind === ts.SyntaxKind.CallExpression) {
          let call = <ts.CallExpression>decorator.expression
          let decoratorType = processTypeNode(call.expression)
          if ((<s.TypeTemplate>decoratorType).typeKind) {
            throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText())
          }
          schema.decorators.push({
            decoratorType: <s.Reference>decoratorType,
            parameters: call.arguments.map(function(arg: ts.Expression) {
              return processExpression(arg)
            })
          })
        }
      })
    }
  }

  return modules
}

interface Globals {
  types: s.Map<ts.Symbol>
  modules: s.Map<ts.Symbol>
}

function getGlobals(p: ts.Program): Globals {
  let tc = p.getTypeChecker()
  let libDTS = p.getSourceFiles().filter(function(sf) {
    return sf.fileName.indexOf('/lib.d.ts') === sf.fileName.length - '/lib.d.ts'.length
  })[0]
  let types: s.Map<ts.Symbol> = {}
  let modules: s.Map<ts.Symbol> = {}

  tc.getSymbolsInScope(libDTS, ts.SymbolFlags.Type).forEach(type=> {
    types[type.name] = type
  })
  tc.getSymbolsInScope(libDTS, ts.SymbolFlags.Module).forEach(module=> {
    if (module.name.charAt(0) === '"' || module.name.charAt(0) === '\'') {
      modules[module.name.substring(1, module.name.length - 1)] = module
    } else {
      modules[module.name] = module
    }
  })

  return {
    types: types,
    modules: modules
  }
}

function loadAllFiles(files: string[]): string[] {
  let allFiles: s.Map<boolean> = {}
  let allFilesArr: string[] = []
  files.forEach(function(fileName) {
    allFilesArr.push(fileName)
  })

  function loadFile(fileName: string) {
    if (!allFiles[fileName]) {
      allFiles[fileName] = true
      allFilesArr.push(fileName)

      let processed = ts.preProcessFile(fs.readFileSync(fileName).toString(), true)

      processed.referencedFiles.concat(processed.importedFiles).forEach(function(referencedFile) {
        let referenceFileName = path.join(path.dirname(fileName), referencedFile.fileName)
        if (referenceFileName.indexOf('.ts') !== referenceFileName.length - 3) {
          if (fs.existsSync(referenceFileName + '.ts')) {
            referenceFileName += '.ts'
          } else {
            referenceFileName += '.d.ts'
          }
        }
        if (fs.existsSync(referenceFileName)) {
          loadFile(referenceFileName)
        }
      })
    }
  }

  files.forEach(loadFile)

  return allFilesArr
}

function createRawTypeContainer(): s.RawTypeContainer {
  return {
    classConstructors: {},
    interfaceConstructors: {},
    types: {},
    statics: {},
    reexports: {},
    namespaces: {}
  }
}

function isExported(node: ts.Node) {
  let isExported = false
  let children = node.getChildren()
  for (let i = 0; i < children.length; i++) {
    if (children[i].kind === ts.SyntaxKind.SyntaxList) {
      let grandChildren = children[i].getChildren()
      for (let j = 0; j < grandChildren.length; j++) {
        if (grandChildren[j].kind === ts.SyntaxKind.ExportKeyword) {
          return true
        }
      }
    }
  }
  return false
}

function getName(id: ts.Identifier|ts.LiteralExpression|ts.ComputedPropertyName|ts.BindingPattern): string|string[] {
  switch (id.kind) {
    case ts.SyntaxKind.ComputedPropertyName:
      let computedPropertyName = <ts.ComputedPropertyName>id
      let prop = <ts.PropertyAccessExpression>computedPropertyName.expression
      return (<ts.Identifier>prop.name).text
    case ts.SyntaxKind.ArrayBindingPattern:
    case ts.SyntaxKind.ObjectBindingPattern:
    // TODO
    default:
      return (<ts.Identifier>id).text
  }
}
