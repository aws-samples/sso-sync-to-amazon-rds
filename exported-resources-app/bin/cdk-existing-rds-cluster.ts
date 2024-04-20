#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { OutputsStack } from '../lib/cdk-outputs-stack';

const importApp = new cdk.App();

const env = process.env.CDK_ENV || "dev";

const envDefault = { 
    region: process.env.CDK_DEFAULT_REGION, 
    account: process.env.CDK_DEFAULT_ACCOUNT,
}

new OutputsStack (importApp, "OutputStack");
