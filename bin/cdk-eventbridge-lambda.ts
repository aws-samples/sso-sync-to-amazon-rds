#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NewSSOUserToRDS } from '../lib/cdk-eventbridge-lambda-stack';
import { LambdaSNSFailureNotification } from '../lib/cdk-lambda-sns-stack';

const app = new cdk.App();

let notificationDestination = undefined;
const env = process.env.CDK_ENV || "dev";
const email = app.node.tryGetContext(env).NOTIFICATION_EMAIL;

const envDefault = { 
    region: process.env.CDK_DEFAULT_REGION, 
    account: process.env.CDK_DEFAULT_ACCOUNT,
}

if (email != null) {
    notificationDestination = new LambdaSNSFailureNotification(app, 'LambdaSNSFailureNotificationStack', {
        env: envDefault,
        email: email,
    });
}

new NewSSOUserToRDS(app, 'NewSsoUserToRdsStack', { 
    env: envDefault,
    onFailureDest: notificationDestination?.notifyFailureDest,
});
