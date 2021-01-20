"use strict";

let Service, Characteristic, api; 

const _http_base = require("homebridge-http-base");
const http = _http_base.http;
const configParser = _http_base.configParser;
const PullTimer = _http_base.PullTimer;
const notifications = _http_base.notifications;
const MQTTClient = _http_base.MQTTClient;
const Cache = _http_base.Cache;
const utils = _http_base.utils;

const packageJSON = require("./package.json");

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;

    api = homebridge;

    homebridge.registerAccessory("homebridge-http-co2-sensor", "HTTP-CO2", HTTP_CO2);
};

function HTTP_CO2(log, config) {
    this.log = log;
    this.name = config.name;
    this.debug = config.debug || false;

    if (config.getUrl) {
        try {
            this.getUrl = configParser.parseUrlProperty(config.getUrl);
        } catch (error) {
            this.log.warn("Error occurred while parsing 'getUrl': " + error.message);
            this.log.warn("Aborting...");
            return;
        }
    }
    else {
        this.log.warn("Property 'getUrl' is required!");
        this.log.warn("Aborting...");
        return;
    }

    this.statusCache = new Cache(config.statusCache, 0);
    this.statusPattern = /([0-9]{1,3})/;
    try {
        if (config.statusPattern)
            this.statusPattern = configParser.parsePattern(config.statusPattern);
    } catch (error) {
        this.log.warn("Property 'statusPattern' was given in an unsupported type. Using default value!");
    }
    this.patternGroupToExtract = 1;
    if (config.patternGroupToExtract) {
        if (typeof config.patternGroupToExtract === "number")
            this.patternGroupToExtract = config.patternGroupToExtract;
        else
            this.log.warn("Property 'patternGroupToExtract' must be a number! Using default value!");
    }

    this.homebridgeService = new Service.CarbonDioxideSensor(this.name);
    this.homebridgeService.getCharacteristic(Characteristic.CarbonDioxideLevel)
        .on("get", this.getCO2.bind(this));
    
    
    
   

    /** @namespace config.pullInterval */
    if (config.pullInterval) {
        this.pullTimer = new PullTimer(this.log, config.pullInterval, this.getCO2.bind(this), value => {
           this.homebridgeService.setCharacteristic(Characteristic.CarbonDioxideLevel, value);
           
        });
        this.pullTimer.start();
    }

    /** @namespace config.notificationPassword */
    /** @namespace config.notificationID */
    notifications.enqueueNotificationRegistrationIfDefined(api, log, config.notificationID, config.notificationPassword, this.handleNotification.bind(this));

    /** @namespace config.mqtt */
    if (config.mqtt) {
        let options;
        try {
            options = configParser.parseMQTTOptions(config.mqtt);
        } catch (error) {
            this.log.error("Error occurred while parsing MQTT property: " + error.message);
            this.log.error("MQTT will not be enabled!");
        }

        if (options) {
            try {
                this.mqttClient = new MQTTClient(this.homebridgeService, options, this.log);
                this.mqttClient.connect();
            } catch (error) {
                this.log.error("Error occurred creating MQTT client: " + error.message);
            }
        }
    }
}

HTTP_CO2.prototype = {

    identify: function (callback) {
        this.log("Identify requested!");
        callback();
    },

    getServices: function () {
        if (!this.homebridgeService)
            return [];

        const informationService = new Service.AccessoryInformation();

        informationService
            .setCharacteristic(Characteristic.Manufacturer, "Robomigo")
            .setCharacteristic(Characteristic.Model, "HTTP CO2 Sensor")
            .setCharacteristic(Characteristic.SerialNumber, "RBM01")
            .setCharacteristic(Characteristic.FirmwareRevision, packageJSON.version);

        return [informationService, this.homebridgeService];
    },

    handleNotification: function(body) {
        const characteristic = utils.getCharacteristic(this.homebridgeService, "CarbonDioxideLevel");
        if (!characteristic) {
            this.log("Encountered unknown characteristic when handling notification (or characteristic which wasn't added to the service): " + body.characteristic);
            return;
        }

       
            this.log("Updating CarbonDioxideLevel to new value: " + body.value);
        characteristic.updateValue(body.value);
    },

    getCO2: function (callback) {
        if (!this.statusCache.shouldQuery()) {
            const value = this.homebridgeService.getCharacteristic(Characteristic.CarbonDioxideLevel).value;
            if (this.debug)
                this.log(`Co2 returning cached value ${value}${this.statusCache.isInfinite()? " (infinite cache)": ""}`);

            callback(null, value);
            return;
        }

        http.httpRequest(this.getUrl, (error, response, body) => {
            if (this.pullTimer)
                this.pullTimer.resetTimer();

            if (error) {
                this.log("Co2 failed: %s", error.message);
                callback(error);
            }
            else if (!http.isHttpSuccessCode(response.statusCode)) {
                this.log("Co2 returned http error: %s", response.statusCode);
                callback(new Error("Got http error code " + response.statusCode));
            }
            else {
                let co2level;
                try {
                    co2level = utils.extractValueFromPattern(this.statusPattern, body, this.patternGroupToExtract);
                } catch (error) {
                    this.log("Co2 error occurred while extracting co2 from body: " + error.message);
                    callback(new Error("pattern error"));
                    return;
                }

                if (this.debug)
                    this.log("Co2 is currently at %s", co2level);

                this.statusCache.queried();
                callback(null, co2level);
            }
        });
    },

};
