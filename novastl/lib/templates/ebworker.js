var EBApp = require('../templates/ebapp')
    , EBOptionsSettings = require('../utils/eb-option-settings')
    , novaform = require('novaform');

function EBWorker(options) {
    if (!(this instanceof EBWorker)) {
        return new EBWorker(options);
    }

    options.optionSettings = options.optionSettings.concat(EBOptionsSettings({
        'aws:elasticbeanstalk:sqsd': {
            WorkerQueueURL: options.sqsUrl,
            HttpPath: options.httpPath,
        },
    }));

    EBApp.call(this, options);

    var oldEnv = this.getResource('environment');
    var oldEnvProps = oldEnv.properties;
    this._resources.environment = novaform.eb.Environment(oldEnv.name, {
        Description: oldEnvProps.Description,
        ApplicationName: oldEnvProps.ApplicationName,
        TemplateName: oldEnvProps.TemplateName,
        VersionLabel: oldEnvProps.VersionLabel,
        Tier: {
            Name: 'Worker',
            Type: 'SQS/HTTP',
            Version: '1.0',
        },
    });
}
EBWorker.prototype = Object.create(EBApp.prototype);

module.exports = EBWorker;