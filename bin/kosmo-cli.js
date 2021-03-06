var _ = require('lodash')
    , AWS = require('aws-sdk')
    , commands = require('../lib/commands')
    , fs = require('fs')
    , KosmoError = require('../lib/kosmo-error')
    , getopt = require('node-getopt')
    , program = require('../lib/program')
    , util = require('util')
    , utils = require('../lib/utils')
    , yaml = require('js-yaml');

function parseCommandLine() {
    var args = process.argv.slice(2);

    // find index of the first command (if present)
    var commandIndex = _(commands)
        .keys()
        .map((command) => {
            return _.indexOf(args, command);
        })
        .find((idx) => {
            return idx != -1;
        });

    var programArgs = [];
    var commandName;
    var commandArgs = [];

    if (typeof commandIndex == 'undefined') {
        programArgs = args;
    } else {
        programArgs = args.slice(0, commandIndex);
        commandName = args[commandIndex];
        commandArgs = args.slice(commandIndex + 1);
    }

    var programOptions = getopt.create([
        ['', 'profile=ARG', 'Set which aws profile to use for credentials'],
        ['', 'params=ARG+', 'Yml configuration file passed in to your kosmo deployment definition'],
        ['v', 'verbose', 'Print more stuff'],
        ['d', 'debug', 'Print insane amounts of logs'],
        ['f', 'output-format=ARG', 'Output format (json or text) - defaults to json'],
        ['', 'version', 'Display current version'],
        ['h', 'help', 'Display help'],
    ]);

    var commandDescriptions = _.map(commands, function(command, name) {
        // Pad right to get consistent tabs
        const maxCommandLengthBeforeTab = 8;
        name = _.padEnd((name + ':'), maxCommandLengthBeforeTab);
        return util.format('  %s\t%s', name, command.descriptionText);
    }).join('\n');

    programOptions.setHelp(util.format(
'Usage: kosmo [common_options] command [command_options]\n\n\
Common options:\n\
[[OPTIONS]]\n\n\
Commands:\n\
%s\n\
', commandDescriptions));

    var parsedProgramOptions = programOptions.parse(programArgs);

    if (parsedProgramOptions.argv.length !== 0) {
        // something is wrong, we shouldn't have left over argument here,
        // treat it as fake command name to report an error later.
        commandName = parsedProgramOptions.argv[0];
    }

    var showHelp = (error) => {
        if (error) {
            console.error(error.toString());
        }
        console.error(programOptions.getHelp());
    };

    var outputFormat = parsedProgramOptions.options['output-format'] = parsedProgramOptions.options['output-format'] || 'text';
    if (outputFormat !== 'text' && outputFormat !== 'json') {
        showHelp(new Error('Invalid output format'));
        process.exit(0);
    }

    if (commandName && !commands[commandName]) {
        showHelp(new Error('Unknown command specified - ' + commandName));
        process.exit(0);
    }

    if (parsedProgramOptions.options['debug']) {
        parsedProgramOptions.options['verbose'] = true;
    }

    return {
        programOptions: parsedProgramOptions.options,
        commandName: commandName,
        commandArguments: commandArgs,
        showHelp: showHelp,
    };
}

function parseCommandArguments(commandName, commandArguments) {
    var command = commands[commandName];
    var extendedCommandOptions = (command.options || []).concat([['h', 'help', 'Display help']]);
    var commandOptions = getopt.create(extendedCommandOptions);
    commandOptions.setHelp('[[OPTIONS]]\n');

    var parsedCommandOptions = commandOptions.parse(commandArguments);

    var showHelp = (error) => {
        var commandUsage = commands[commandName].usageText;
        if (error) {
            console.error(error.toString());
        }

        console.error(util.format(
'\nUsage: kosmo %s %s\n\n\
Options:\n\
%s\n'
, commandName, commandUsage, commandOptions.getHelp()));
    };

    return {
        commandOptions: parsedCommandOptions,
        showHelp: showHelp,
    };
}

function isUserRetarded(question) {
    return utils.yesorno(question).then(userRetarded => {
        if (userRetarded) {
            throw new Error('User is retarded.');
        }

        throw new Error('Hmm... well this may be a bug then. Kosmo leaves the next steps to you.');
    });
}

function ensureKosmoBucket() {
    var kosmoBucket;
    try {
        kosmoBucket = program.getKosmoBucket();
    } catch (e) {
        // Not initied yet. Carry on...
        return;
    }

    var s3 = new AWS.S3({ region: kosmoBucket.region });
    var getLocation = utils.pbind(s3.getBucketLocation, s3, {
        Bucket: kosmoBucket.name,
    });
    return getLocation().then(data => {
        if (data.LocationConstraint !== kosmoBucket.region) {
            var question = `Kosmo confused. Expected kosmo bucket in '${kosmoBucket.region}', but found in '${data.Location}'.`
                + ' Did you recreate the bucket in another region?';
            return isUserRetarded(question);
        }
    });
}

function initAws(profile, debug) {
    if (debug) {
        AWS.config.logger = process.stdout;
    }

    var credentials =
        profile
            ? new AWS.SharedIniFileCredentials({ profile: profile })
            : new AWS.EnvironmentCredentials('AWS');

    var refresh = utils.pbind(credentials.refresh, credentials);
    return refresh()
        .then(() => AWS.config.credentials = credentials)
        .then(ensureKosmoBucket)
        .catch(err => {
            if (err.code === 'NoSuchBucket') {
                var question = 'Well this is awkward. Expected kosmo bucket, but I haz none. '
                    + 'Did you delete it manually from S3?';
                return isUserRetarded(question);
            }

            throw new Error('Failed to initialize AWS - make sure you provide --profile or set AWS_ACCESS_KEY_ID env var');
        });
}

function mergeDeep(value1, value2, resolver) {
    function _mergeDeep(value1, value2, path1, path2) {
        if (typeof value1 !== typeof value2) {
            return resolver(value1, value2, path1, path2) || value2;
        }

        if (_.isArray(value1) && _.isArray(value2)) {
            return resolver(value1, value2, path1, path2) || value1.concat(value2);
        } else if (_.isArray(value1) || _.isArray(value2)) {
            return resolver(value1, value2, path1, path2) || value2;
        }

        if (_.isObject(value1) && _.isObject(value2)) {
            var keys1 = _.keys(value1);
            var keys2 = _.keys(value2);

            var result = {};

            // add distinct keys
            var distinctKeys = _.difference(keys1, keys2).concat(_.difference(keys2, keys1));
            result = _.extend(result,
              _.pick(value1, distinctKeys),
              _.pick(value2, distinctKeys));

            // recursively merge common keys
            var commonKeys = _.intersection(keys1, keys2);
            var common = _.reduce(commonKeys, function(memo, key) {
                var value = _mergeDeep(value1[key], value2[key], path1+'.'+key, path2+'.'+key);
                memo[key] = value;
                return memo;
            }, {});

            result = _.extend(result, common);
            return result;
        }

        return resolver(value1, value2, path1, path2) || value2;
    }

    if (!_.isObject(value1) || !_.isObject(value2)) {
        resolver(null, null, '<root>', '<root>');
        return value2;
    }

    return _mergeDeep(value1, value2, '', '');
}

function readParams(paramsFiles) {
    if (!paramsFiles || paramsFiles.length === 0) {
        return Promise.resolve({});
    }

    var promises = _.map(paramsFiles, (paramsFile) => {
        var readFile = utils.pbind(fs.readFile, fs, paramsFile, { encoding: 'utf-8', flag: 'r' });
        return readFile();
    });

    return Promise.all(promises).then(datas => {
        return _.reduce(datas, (memo, data) => {
            var object = yaml.safeLoad(data) || {};

            return mergeDeep(memo, object, (value1, value2, path1, path2) => {
                console.log('Warning: cannot cleanly merge params files ("%s" and "%s")...', path1, path2);
            });
        }, {});
    });
}

function executeCommand(commandName, commandArguments) {
    return Promise.resolve(commands[commandName])
        .then(command => new command(commandArguments.commandOptions))
        .then(command => command.execute())
        .catch(err => {
            if (err instanceof KosmoError) {
                console.log(err.toString());
                return;
            }

            if (!(err instanceof Error)) {
                commandArguments.showHelp('Unexpected error object: ' + err);
                return;
            }

            if (err.code === 'CredentialsError') {
                err.message = 'Kosmo seems to have failed to set AWS credentials. Something is fishy. And it\'s not Nemo.';
            }

            if (commandLine.programOptions.debug) {
                commandArguments.showHelp(err.stack);
            } else {
                commandArguments.showHelp(err.toString());
            }
        });
}

var commandLine = parseCommandLine();

if (commandLine.programOptions.help) {
    commandLine.showHelp();
    process.exit(0);
}

if (commandLine.programOptions.version) {
    console.log(program.getVersion());
    process.exit(0);
}

if (!commands[commandLine.commandName]) {
    commandLine.showHelp(new Error('Expected command'));
    process.exit(0);
}

var commandArguments = parseCommandArguments(commandLine.commandName, commandLine.commandArguments);

if (commandArguments.commandOptions.options.help) {
    commandArguments.showHelp();
    process.exit(0);
}

Promise.resolve()
    .then(() => readParams(commandLine.programOptions.params))
    .then(paramsObject => program.params = paramsObject)
    .then(() => program.options = commandLine.programOptions)
    .then(() => {
        if (!commands[commandLine.commandName].skipAws) {
            return initAws(commandLine.programOptions.profile, commandLine.programOptions.debug);
        }
    })
    .then(() => executeCommand(commandLine.commandName, commandArguments))
    .catch(err => {
        if (!(err instanceof Error)) {
            commandLine.showHelp(new Error('Unexpected error object: ' + err));
            return;
        }

        if (commandLine.programOptions.debug) {
            commandLine.showHelp(new Error(err.stack));
        } else {
            commandLine.showHelp(err);
        }
    });
