var s = require('typescript-schema');
var ts = require('typescript');
var path = require('path');
var fs = require('fs');
var utils = require('./packageUtils');
function generateRawPackage(pkgDir, options, host) {
    var allRawModules = {};
    var packageJson = utils.getPackageJson(pkgDir);
    var files = utils.getSourceFilesList(pkgDir);
    files = loadAllFiles(files);
    var pkgs = {};
    var p = ts.createProgram(files, options || { target: 1 }, host);
    p.getSourceFiles().forEach(function (sf) {
        var file = sf.fileName;
        var dirName = path.dirname(file);
        while (true) {
            if (fs.existsSync(path.join(dirName, 'package.json'))) {
                var pkgJson = JSON.parse(fs.readFileSync(path.join(dirName, 'package.json')).toString());
                pkgs[file] = [pkgJson.name, path.relative(pkgDir, dirName).replace(/\\/g, '/')];
                break;
            }
            else {
                dirName = path.dirname(dirName);
            }
            if (dirName === path.join(dirName, '..')) {
                throw new Error('Package not found for file: ' + file);
            }
        }
    });
    function relativePrefix(fileName, moduleName) {
        var pkg = pkgs[fileName];
        return path.posix.join(pkg[0], path.posix.relative(pkg[1], moduleName));
    }
    return generateRawModules(p, pkgDir, relativePrefix);
}
exports.generateRawPackage = generateRawPackage;
function generateRawModules(p, rootDir, relativePrefix) {
    var modules = {};
    var globals = getGlobals(p);
    var tc = p.getTypeChecker();
    p.getSourceFiles().forEach(function (sf) {
        processSourceFile(sf);
    });
    function processSourceFile(sf) {
        var moduleNames = [];
        var isModule = false;
        ts.forEachChild(sf, function (node) {
            if (isExported(node) || node.kind === 226) {
                isModule = true;
            }
        });
        if (isModule) {
            var moduleName = utils.fileNameToModuleName(sf.fileName, rootDir, relativePrefix);
            modules[moduleName] = processModule(moduleName, sf);
            moduleNames.push(moduleName);
        }
        else {
            moduleNames = moduleNames.concat(processDeclarationFile(sf));
        }
        return moduleNames;
    }
    function processModule(moduleName, moduleNode, module, isDeclared) {
        if (!module) {
            module = createRawTypeContainer();
        }
        processTypeContainer(moduleName, module, moduleNode, isDeclared);
        return module;
    }
    function processDeclarationFile(declarationFile) {
        var globalModule = modules[''];
        if (!globalModule) {
            globalModule = createRawTypeContainer();
            modules[''] = globalModule;
        }
        return processTypeContainer('', globalModule, declarationFile, true);
    }
    function processExport(typeContainer, node) {
        switch (node.kind) {
            case 191:
                var vars = node;
                var valueKind = vars.declarationList.flags === 32768 ? s.ValueKind.CONST : (vars.declarationList.flags === 16384 ? s.ValueKind.LET : s.ValueKind.VAR);
                vars.declarationList.declarations.forEach(function (varDec) {
                    var name = getName(varDec.name);
                    if (Array.isArray(name)) {
                    }
                    else {
                        typeContainer.statics[name] = {
                            valueKind: valueKind,
                            type: processType(tc.getTypeAtLocation(varDec))
                        };
                        if (varDec.initializer) {
                            typeContainer.statics[name].initialiser = processExpression(varDec.initializer);
                        }
                    }
                });
                break;
            case 213:
                populateInterface(node, typeContainer);
                break;
            case 212:
                populateClass(typeContainer, node);
                break;
            case 215:
                var enumDec = node;
                typeContainer.types[enumDec.name.text] = {
                    typeKind: s.TypeKind.ENUM,
                    members: enumDec.members.map(function (member) {
                        var enumMember = {
                            name: getName(member.name)
                        };
                        if (member.initializer) {
                            enumMember.initialiser = processExpression(member.initializer);
                        }
                        return enumMember;
                    })
                };
                break;
            case 214:
                populateAlias(typeContainer, node);
                break;
            case 211:
                var func = node;
                typeContainer.statics[func.name.text] = {
                    valueKind: s.ValueKind.FUNCTION,
                    type: processSignatureType(func)
                };
                break;
        }
    }
    function processSymbolTable(typeContainerName, typeContainer, symbolTable) {
        Object.keys(symbolTable).forEach(function (name) {
            var symbol = symbolTable[name];
            if (symbol && symbol.declarations) {
                symbol.declarations.forEach(function (dec) {
                    if (dec.kind === 226) {
                        var exportDec = dec;
                        processSymbolTable(typeContainerName + ':' + name, typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports);
                    }
                    else if (dec.kind === 225) {
                        var exportAssignment = dec;
                        var exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression);
                        var exportType = tc.getTypeAtLocation(exportAssignment.expression);
                        if (exportType && exportType.symbol && exportType.symbol.exports) {
                            processSymbolTable(typeContainerName, typeContainer, exportType.symbol.exports || exportType.symbol.members);
                        }
                        else if (exportSymbol.exports) {
                            processSymbolTable(typeContainerName, typeContainer, exportSymbol.exports);
                        }
                        else {
                            var importDec = exportSymbol.declarations[0];
                            processSymbolTable(typeContainerName, typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members);
                        }
                    }
                    else {
                        if (dec.kind !== 145) {
                            var ref = getReference(dec, dec.kind === 216);
                            if (ref.module !== typeContainerName) {
                                typeContainer.reexports[name] = ref;
                            }
                        }
                    }
                });
            }
        });
    }
    function processTypeContainer(typeContainerName, typeContainer, node, isDeclaredModule) {
        var moduleNames = [];
        ts.forEachChild(node, function (child) {
            switch (child.kind) {
                case 225:
                    var exportAssignment = child;
                    var exportSymbol = tc.getSymbolAtLocation(exportAssignment.expression);
                    var exportType = tc.getTypeAtLocation(exportAssignment.expression);
                    if (exportType && exportType.symbol && exportType.symbol.exports) {
                        processSymbolTable(typeContainerName, typeContainer, exportType.symbol.exports || exportType.symbol.members);
                    }
                    else if (exportSymbol.exports) {
                        processSymbolTable(typeContainerName, typeContainer, exportSymbol.exports);
                    }
                    else {
                        var importDec = exportSymbol.declarations[0];
                        processSymbolTable(typeContainerName, typeContainer, tc.getTypeAtLocation(importDec).symbol.exports || tc.getTypeAtLocation(importDec).symbol.members);
                    }
                    break;
                case 226:
                    var exportDec = child;
                    var exportClause = exportDec.exportClause;
                    if (exportClause) {
                        var moduleName = getReference(tc.getSymbolAtLocation(exportDec.moduleSpecifier), true).module;
                        exportDec.exportClause.elements.forEach(function (element) {
                            if (element.propertyName) {
                                typeContainer.reexports[element.name.text] = {
                                    module: moduleName,
                                    name: element.propertyName.text
                                };
                            }
                            else {
                                typeContainer.reexports[element.name.text] = {
                                    module: moduleName,
                                    name: element.name.text
                                };
                            }
                        });
                    }
                    processSymbolTable(typeContainerName, typeContainer, tc.getSymbolAtLocation(exportDec.moduleSpecifier).exports || tc.getSymbolAtLocation(exportDec.moduleSpecifier).members);
                    break;
                default:
                    if (isDeclaredModule || modules[''] === typeContainer || isExported(child)) {
                        switch (child.kind) {
                            case 216:
                                var modDec = child;
                                var name_1 = modDec.name.text;
                                var symbol = tc.getTypeAtLocation(modDec).symbol;
                                if (modules[''] === typeContainer && symbol && (symbol.name.charAt(0) === '"' || symbol.name.charAt(0) === '\'')) {
                                    ts.forEachChild(modDec, function (child) {
                                        if (child.kind === 217) {
                                            modules[name_1] = processModule(name_1, child, modules[name_1], true);
                                            moduleNames.push(name_1);
                                        }
                                    });
                                }
                                else {
                                    var namespace = typeContainer.namespaces[name_1] || createRawTypeContainer();
                                    typeContainer.namespaces[name_1] = namespace;
                                    ts.forEachChild(modDec, function (child) {
                                        if (child.kind === 217) {
                                            processTypeContainer(typeContainerName + ':' + name_1, namespace, child, isDeclaredModule);
                                        }
                                    });
                                }
                                break;
                            default:
                                processExport(typeContainer, child);
                        }
                    }
            }
        });
        return moduleNames;
    }
    function getReference(symbolOrDec, isModule) {
        var moduleName;
        var isGlobal = false;
        var dec;
        var name;
        if (symbolOrDec.kind) {
            dec = symbolOrDec;
            name = getName(dec.name);
            var globalSymbol = globals.types[name];
            isGlobal = !isModule && globalSymbol && globalSymbol.declarations[0] === dec;
        }
        else {
            var symbol = symbolOrDec;
            dec = symbol.declarations[0];
            name = symbol.name;
            isGlobal = !isModule && globals.types[name] === symbol;
        }
        if (isGlobal) {
            moduleName = '';
        }
        else {
            var name_2 = '';
            var node = isModule ? dec : dec.parent;
            while (node.kind !== 246) {
                switch (node.kind) {
                    case 216:
                        var mod = node;
                        name_2 = mod.name.text + (name_2 === '' ? '' : (':' + name_2));
                        if (node.parent.kind === 246 && globals.modules[mod.name.text]) {
                            moduleName = name_2;
                            break;
                        }
                }
                node = node.parent;
            }
            if (moduleName) {
                if (relativePrefix && moduleName.substring(0, 2) === './') {
                    if (relativePrefix.charAt) {
                        moduleName = path.posix.join(relativePrefix, moduleName);
                    }
                    else {
                        moduleName = relativePrefix(node.fileName, moduleName);
                    }
                }
            }
            else if (node.fileName.substring(node.fileName.length - 8) === 'lib.d.ts') {
                moduleName = '';
            }
            else {
                moduleName = utils.fileNameToModuleName(node.fileName, rootDir, relativePrefix) + (name_2 === '' ? '' : (':' + name_2));
            }
        }
        var reference = {
            module: moduleName
        };
        if (!isModule) {
            reference.name = name;
        }
        return reference;
    }
    function processTypeNode(node, typeNode) {
        var isTypeQuery = (typeNode && typeNode.kind === 152) || node.kind === 152;
        var type;
        if (isTypeQuery) {
            var typeSymbol = tc.getSymbolAtLocation(typeNode || node);
            if (!typeSymbol) {
                return {
                    typeKind: s.TypeKind.TYPE_QUERY
                };
            }
            else {
                var typeSymbolDec = typeSymbol.declarations[0];
                var ref;
                switch (typeSymbolDec.kind) {
                    case 216:
                        return getReference(typeSymbol, true);
                    case 209:
                    case 211:
                        ref = getReference(typeSymbol, false);
                    default:
                        var type_1 = tc.getTypeAtLocation(typeNode || node);
                        if (!type_1.symbol) {
                            ref = getReference(tc.getSymbolAtLocation(typeNode || node), false);
                        }
                        else {
                            ref = processType(type_1);
                        }
                }
                return {
                    typeKind: s.TypeKind.TYPE_QUERY,
                    type: ref
                };
            }
        }
        else {
            var type_2 = tc.getTypeAtLocation(typeNode || node);
            if (type_2.typeParameters) {
                var typeArgNode = (typeNode || node).kind === 67 ? (typeNode || node).parent : (typeNode || node);
                if (typeArgNode.kind === 154) {
                    var arrayType = typeArgNode;
                    return {
                        reference: {
                            module: '',
                            name: 'Array'
                        },
                        typeArguments: [processTypeNode(arrayType.elementType)]
                    };
                }
                else {
                    var typeArguments = typeArgNode.typeArguments;
                    var reference;
                    if (!type_2.symbol && tc.getSymbolAtLocation(typeNode || node)) {
                        reference = getReference(tc.getSymbolAtLocation(typeNode || node), false);
                    }
                    else {
                        reference = processType(type_2);
                    }
                    return {
                        reference: reference,
                        typeArguments: typeArguments.map(function (typeArg) {
                            return processTypeNode(typeArg);
                        })
                    };
                }
            }
            else if (!type_2.symbol && tc.getSymbolAtLocation(typeNode || node)) {
                return getReference(tc.getSymbolAtLocation(typeNode || node), false);
            }
            else {
                return processType(type_2);
            }
        }
    }
    function processType(type) {
        switch (type.flags) {
            case 1:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.ANY
                };
            case 2:
            case 256:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.STRING
                };
            case 4:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.NUMBER
                };
            case 8:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.BOOLEAN
                };
            case 16:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.VOID
                };
            case 16777216:
                return {
                    typeKind: s.TypeKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.SYMBOL
                };
            case 128:
            case 1024:
            case 2048:
            case 4096 + 1024:
            case 4096 + 2048:
                return getReference(type.symbol, false);
            case 512:
                return {
                    module: '@',
                    name: type.symbol.name
                };
            case 8192:
                var tupleType = type;
                return {
                    typeKind: s.TypeKind.TUPLE,
                    elements: tupleType.elementTypes.map(processType)
                };
                tupleType.elementTypes;
            case 16384:
                var unionType = type;
                return {
                    typeKind: s.TypeKind.UNION,
                    types: unionType.types.map(processType)
                };
            case 32768:
                return {
                    typeKind: s.TypeKind.INTERSECTION,
                    types: unionType.types.map(processType)
                };
            case 4096:
            case (4096 + 2048):
                var referenceType = type;
                return getReference(referenceType.target.symbol, false);
            case 65536:
                var declaration = type.symbol.declarations[0];
                switch (declaration.kind) {
                    case 211:
                        return getReference(declaration, false);
                    case 171:
                    case 150:
                    case 140:
                    case 141:
                        return processSignatureType(declaration);
                    case 212:
                    case 142:
                        return getReference(type.symbol, false);
                    case 163:
                        var literalCompositeType = {
                            typeKind: s.TypeKind.COMPOSITE,
                            members: {}
                        };
                        var ole = declaration;
                        ole.properties.forEach(function (property) {
                            literalCompositeType.members[getName(property.name)] = {
                                type: processTypeNode(property)
                            };
                        });
                        return s.ANY;
                    case 153:
                        var typeLiteral = declaration;
                        var compositeType = {
                            typeKind: s.TypeKind.COMPOSITE,
                            members: {}
                        };
                        populateMembers(compositeType, typeLiteral.members);
                        return compositeType;
                    case 216:
                        return getReference(type.symbol, true);
                    default:
                        throw new Error('Unrecognised Type: ' + type.flags);
                }
                break;
            default:
                throw new Error('Unrecognised Type: ' + type.flags);
        }
    }
    function processSignatureType(declaration) {
        var typeParameters = [];
        if (declaration.typeParameters) {
            declaration.typeParameters.forEach(function (typeParameter) {
                typeParameters.push({ name: typeParameter.name.text });
            });
        }
        var params = declaration.parameters.map(function (paramDec) {
            var parameter = {
                name: paramDec.name.text,
                type: processTypeNode(paramDec, paramDec.type)
            };
            if (paramDec.questionToken) {
                parameter.optional = true;
            }
            if (paramDec.initializer) {
                parameter.initialiser = processExpression(paramDec.initializer);
            }
            processDecorators(paramDec, parameter);
            return parameter;
        });
        var rawFunctionType = {
            typeKind: s.TypeKind.FUNCTION,
            parameters: params,
            type: (!declaration.type || declaration.type.kind === 101) ? undefined : processTypeNode(declaration.type)
        };
        if (typeParameters.length > 0) {
            rawFunctionType.typeParameters = typeParameters;
        }
        return rawFunctionType;
    }
    function populateMembers(parent, nodes) {
        nodes.forEach(function (node) {
            switch (node.kind) {
                case 147:
                    var index = node;
                    parent.index = {
                        keyType: processTypeNode(index.parameters[0], index.parameters[0].type),
                        valueType: processTypeNode(index.type)
                    };
                    break;
                case 146:
                    break;
                case 145:
                    if (!parent.calls) {
                        parent.calls = [];
                    }
                    parent.calls.push(processSignatureType(node));
                    break;
                case 139:
                case 138:
                    var p_1 = node;
                    var propName = getName(p_1.name);
                    parent.members[propName] = {
                        optional: !!p_1.questionToken,
                        type: processTypeNode(p_1)
                    };
                    break;
                default:
                    var declaration = node;
                    var name_3 = getName(declaration.name);
                    parent.members[name_3] = {
                        type: processTypeNode(node)
                    };
            }
        });
    }
    function populateInterface(intDec, parent) {
        var intName = intDec.name.text;
        var int = parent.interfaceConstructors[intName];
        var instanceType;
        if (int) {
            instanceType = int.instanceType;
        }
        else {
            instanceType = {
                typeKind: s.TypeKind.COMPOSITE,
                members: {}
            };
            int = {
                instanceType: instanceType
            };
            parent.interfaceConstructors[intName] = int;
        }
        if (intDec.heritageClauses) {
            intDec.heritageClauses.forEach(function (heritageClause) {
                if (heritageClause.token === 81) {
                    int.extends = processHeritageClause(heritageClause);
                }
            });
        }
        int.typeParameters = processTypeParameters(parent, intDec.typeParameters);
        populateMembers(instanceType, intDec.members);
        return int;
    }
    function populateProtoClass(clsLikeDec, instanceType, staticType) {
        clsLikeDec.members.forEach(function (member) {
            var name;
            var type;
            switch (member.kind) {
                case 147:
                    var index = member;
                    instanceType.index = {
                        keyType: processTypeNode(index.parameters[0].type),
                        valueType: processTypeNode(index.type)
                    };
                    break;
                case 142:
                    var constructorDec = member;
                    staticType.calls.push(processSignatureType(constructorDec));
                    break;
                case 141:
                case 139:
                case 143:
                    var methodDec = member;
                    name = methodDec.name.text;
                    type = processTypeNode(methodDec);
                    break;
            }
            if (name && type) {
                var classMember = {
                    type: type
                };
                processDecorators(member, classMember);
                instanceType.members[name] = classMember;
            }
        });
    }
    function populateClass(parent, clsDec) {
        var name = clsDec.name.text;
        var cls = parent.classConstructors[name];
        var instanceType;
        var staticType;
        if (cls) {
            instanceType = cls.instanceType;
            staticType = cls.staticType;
        }
        else {
            instanceType = {
                typeKind: s.TypeKind.COMPOSITE,
                members: {}
            };
            staticType = {
                typeKind: s.TypeKind.COMPOSITE,
                members: {},
                calls: []
            };
            cls = {
                instanceType: instanceType,
                staticType: staticType
            };
            parent.classConstructors[name] = cls;
        }
        cls.isAbstract = clsDec.modifiers.filter(function (modifier) { return modifier.kind === 113; }).length === 1;
        processDecorators(clsDec, cls);
        if (clsDec.heritageClauses) {
            clsDec.heritageClauses.forEach(function (heritageClause) {
                if (heritageClause.token === 104) {
                    cls.implements = processHeritageClause(heritageClause);
                }
                else if (heritageClause.token === 81) {
                    cls.extends = processHeritageClause(heritageClause)[0];
                }
            });
        }
        if (clsDec.typeParameters) {
            cls.typeParameters = processTypeParameters(parent, clsDec.typeParameters);
        }
        populateProtoClass(clsDec, instanceType, staticType);
        return cls;
    }
    function populateAlias(parent, aliasDec) {
        parent.types[aliasDec.name.text] = {
            typeKind: s.TypeKind.TYPE_ALIAS,
            type: processTypeNode(aliasDec.type)
        };
    }
    function processHeritageClause(heritageClause) {
        return heritageClause.types.map(function (heritageClauseElement) {
            var heritageType = processTypeNode(heritageClauseElement.expression);
            if (heritageType.typeKind) {
                throw new Error('Reference not found: ' + heritageClauseElement.expression.getText() + ' for constructor ' + heritageClause.parent.name.text);
            }
            return heritageType;
        });
    }
    function processTypeParameters(parent, typeParameters) {
        if (typeParameters) {
            return typeParameters.map(function (typeParameter) {
                var typeParameterSchema = {
                    name: typeParameter.name.text
                };
                if (typeParameter.constraint) {
                    typeParameterSchema.extends = processTypeNode(typeParameter.constraint);
                }
                return typeParameterSchema;
            });
        }
    }
    function processExpression(expression) {
        switch (expression.kind) {
            case 67:
                var cls = processTypeNode(expression);
                return {
                    expressionKind: s.ExpressionKind.CLASS_REFERENCE,
                    class: processTypeNode(expression)
                };
            case 184:
                var classExpression = expression;
                var protoClass = {
                    typeKind: s.TypeKind.CLASS,
                    instanceType: {
                        typeKind: s.TypeKind.COMPOSITE,
                        members: {}
                    },
                    staticType: {
                        typeKind: s.TypeKind.COMPOSITE,
                        members: {}
                    }
                };
                populateProtoClass(classExpression, protoClass.instanceType, protoClass.staticType);
                return {
                    expressionKind: s.ExpressionKind.CLASS,
                    class: protoClass
                };
            case 171:
                var functionExpression = expression;
                return {
                    expressionKind: s.ExpressionKind.FUNCTION,
                    functionType: processSignatureType(functionExpression)
                };
            case 166:
                var callExpression = expression;
                return {
                    expressionKind: s.ExpressionKind.FUNCTION_CALL,
                    function: processExpression(callExpression.expression),
                    arguments: callExpression.arguments.map(processExpression)
                };
            case 9:
                return {
                    expressionKind: s.ExpressionKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.STRING,
                    primitiveValue: expression.text
                };
            case 97:
                return {
                    expressionKind: s.ExpressionKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.BOOLEAN,
                    primitiveValue: true
                };
            case 82:
                return {
                    expressionKind: s.ExpressionKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.BOOLEAN,
                    primitiveValue: false
                };
            case 8:
                return {
                    expressionKind: s.ExpressionKind.PRIMITIVE,
                    primitiveTypeKind: s.PrimitiveTypeKind.NUMBER,
                    primitiveValue: parseFloat(expression.text)
                };
            case 163:
                var object = {
                    expressionKind: s.ExpressionKind.OBJECT,
                    properties: {}
                };
                var objectLiteral = expression;
                objectLiteral.properties.forEach(function (property) {
                    var name = property.name.text;
                    var assignment = property.initializer;
                    object.properties[name] = processExpression(assignment);
                });
                return object;
            case 162:
                var array = {
                    expressionKind: s.ExpressionKind.ARRAY,
                    elements: []
                };
                var arrayLiteral = expression;
                arrayLiteral.elements.forEach(function (element) {
                    array.elements.push(processExpression(element));
                });
                return array;
            case 164:
                var pae = expression;
                var name_4 = pae.name.getText();
                if (name_4) {
                    var type = processTypeNode(pae.name);
                    if (type.name) {
                        if (type.name === name_4) {
                        }
                        else {
                            return {
                                enum: type,
                                value: name_4,
                                expressionKind: s.ExpressionKind.ENUM
                            };
                        }
                    }
                    else {
                    }
                }
            default:
                throw 'Unsupported expression';
        }
    }
    function processDecorators(node, schema) {
        schema.decorators = [];
        if (node.decorators) {
            node.decorators.forEach(function (decorator) {
                if (decorator.expression.kind === 67) {
                    var id = decorator.expression;
                    var decoratorType = processTypeNode(id);
                    if (decoratorType.typeKind) {
                        throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText());
                    }
                    schema.decorators.push({
                        decoratorType: decoratorType
                    });
                }
                else if (decorator.expression.kind === 166) {
                    var call = decorator.expression;
                    var decoratorType = processTypeNode(call.expression);
                    if (decoratorType.typeKind) {
                        throw new Error('Reference not found: ' + decorator.expression.getText() + ' for decorator ' + decorator.getText());
                    }
                    schema.decorators.push({
                        decoratorType: decoratorType,
                        parameters: call.arguments.map(function (arg) {
                            return processExpression(arg);
                        })
                    });
                }
            });
        }
    }
    return modules;
}
exports.generateRawModules = generateRawModules;
function getGlobals(p) {
    var tc = p.getTypeChecker();
    var libDTS = p.getSourceFiles().filter(function (sf) {
        return sf.fileName.indexOf('/lib.d.ts') === sf.fileName.length - '/lib.d.ts'.length;
    })[0];
    var types = {};
    var modules = {};
    tc.getSymbolsInScope(libDTS, 793056).forEach(function (type) {
        types[type.name] = type;
    });
    tc.getSymbolsInScope(libDTS, 1536).forEach(function (module) {
        if (module.name.charAt(0) === '"' || module.name.charAt(0) === '\'') {
            modules[module.name.substring(1, module.name.length - 1)] = module;
        }
        else {
            modules[module.name] = module;
        }
    });
    return {
        types: types,
        modules: modules
    };
}
function loadAllFiles(files) {
    var allFiles = {};
    var allFilesArr = [];
    files.forEach(function (fileName) {
        allFilesArr.push(fileName);
    });
    function loadFile(fileName) {
        if (!allFiles[fileName]) {
            allFiles[fileName] = true;
            allFilesArr.push(fileName);
            var processed = ts.preProcessFile(fs.readFileSync(fileName).toString(), true);
            processed.referencedFiles.concat(processed.importedFiles).forEach(function (referencedFile) {
                var referenceFileName = path.join(path.dirname(fileName), referencedFile.fileName);
                if (referenceFileName.indexOf('.ts') !== referenceFileName.length - 3) {
                    if (fs.existsSync(referenceFileName + '.ts')) {
                        referenceFileName += '.ts';
                    }
                    else {
                        referenceFileName += '.d.ts';
                    }
                }
                if (fs.existsSync(referenceFileName)) {
                    loadFile(referenceFileName);
                }
            });
        }
    }
    files.forEach(loadFile);
    return allFilesArr;
}
function createRawTypeContainer() {
    return {
        classConstructors: {},
        interfaceConstructors: {},
        types: {},
        statics: {},
        reexports: {},
        namespaces: {}
    };
}
function isExported(node) {
    return node.modifiers.filter(function (modifier) { return modifier.kind === 80; });
}
function getName(id) {
    switch (id.kind) {
        case 134:
            var computedPropertyName = id;
            var prop = computedPropertyName.expression;
            return prop.name.text;
        case 160:
        case 159:
        default:
            return id.text;
    }
}
//# sourceMappingURL=rawGenerator.js.map