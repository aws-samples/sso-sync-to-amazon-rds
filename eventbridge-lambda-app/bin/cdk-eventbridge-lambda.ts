#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NewSSOUserToRDS } from '../lib/cdk-eventbridge-lambda-stack';
import { EventBridgeSSOLambda } from '../lib/cdk-eventbridge-idc-stack';
import { LambdaSNSFailureNotification } from '../lib/cdk-lambda-sns-stack';

const app = new cdk.App();

let notificationDestination = undefined;
const env = process.env.CDK_ENV || "dev";
const context = app.node.tryGetContext(env);
const email = context.NOTIFICATION_EMAIL;
const rdsAccountID = context.RDS_ACCOUNT_ID;
const rdsRegion = context.RDS_REGION;
const idcAccountID = context.IDC_ACCOUNT_ID;
const idcRegion = context.IDC_REGION;

const envRDS = { 
    region: rdsRegion, 
    account: rdsAccountID,
};

const envIDC = {
    region: idcRegion,
    account: idcAccountID,
};

if (email != null) {
    notificationDestination = new LambdaSNSFailureNotification(app, 'LambdaSNSFailureNotificationStack', {
        env: envRDS,
        email: email,
    });
}

new EventBridgeSSOLambda(app, 'EventBridgeSSOLambda', {
    env: envIDC
});

new NewSSOUserToRDS(app, 'NewSsoUserToRdsStack', { 
    env: envRDS,
    onFailureDest: notificationDestination?.notifyFailureDest,
});
