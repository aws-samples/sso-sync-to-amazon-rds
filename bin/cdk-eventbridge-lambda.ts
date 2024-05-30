#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NewSSOUserToRDS } from '../lib/cdk-eventbridge-lambda-stack';
import { EventBridgeSSOLambda } from '../lib/cdk-eventbridge-idc-stack';
import { LambdaSNSFailureNotification } from '../lib/cdk-lambda-sns-stack';
import { OutputsStack } from '../lib/cdk-outputs-stack';

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

const outputsStack = new OutputsStack(app, 'Outputs', {
    env: envRDS
});

new EventBridgeSSOLambda(app, 'EventBridgeSSOLambda', {
    env: envIDC
});

const rdsStack = new NewSSOUserToRDS(app, 'EventBridgeLambdaRDS', { 
    env: envRDS,
    onFailureDest: notificationDestination?.notifyFailureDest,
});

rdsStack.addDependency(outputsStack);