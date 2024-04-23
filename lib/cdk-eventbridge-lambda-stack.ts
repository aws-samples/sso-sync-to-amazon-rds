import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { PythonLayerVersion } from '@aws-cdk/aws-lambda-python-alpha';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Vpc, SecurityGroup, InterfaceVpcEndpoint, InterfaceVpcEndpointService, Port, GatewayVpcEndpoint, GatewayVpcEndpointAwsService } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { Runtime } from 'aws-cdk-lib/aws-lambda';

interface NewSSOUserProps extends cdk.StackProps {
  onFailureDest: lambda.IDestination | undefined;
}

export class NewSSOUserToRDS extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: NewSSOUserProps) {
    super(scope, id, props);

    // Get environment to work with, variables are specified in cdk.json
    const env = process.env.CDK_ENV || "dev";
    const context = this.node.tryGetContext(env);

    // RDS, DDB and Lambda account and region
    const accountID = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // IDC account to allow creating events in RDS account
    const idcAccountID = context.IDC_ACCOUNT_ID;

    // Import values from stack
    const rdsClusterEPAddr = cdk.Fn.importValue('rdsClusterEPAddr');
    const dbSgID = cdk.Fn.importValue('dbSgID');
    const rdsEngine = cdk.Fn.importValue('rdsEngine');

    // Import values from parameter store
    const vpcID = ssm.StringParameter.valueFromLookup(this, "/ssotordssync/rdsVpcId");
    const rdsDBPort = +ssm.StringParameter.valueFromLookup(this, "/ssotordssync/rdsDBPort");
    const rdsLambdaDBUser = ssm.StringParameter.valueFromLookup(this, "/ssotordssync/rdsLambdaDBUser");

    // Existing RDS Security Group (first available is selected)
    const dbSG = SecurityGroup.fromSecurityGroupId(this, 'dbSG', dbSgID, {
      mutable: true
    });

    // Custom bus for cross-account event routing
    const ssoBus = new EventBus(this, "ssoBus", {
      eventBusName: "SSO-RDS-Sync-Target",
    });

    // IAM policy for the target bus
    const grantPutToIDCBus = new iam.PolicyStatement({
      sid: "AllowFromIDCAccount",
      actions: ['events:PutEvents'],
      principals: [
        new iam.AccountPrincipal(idcAccountID),
      ],
      resources: [ssoBus.eventBusArn]
    });
    
    // Grant put to the EventBus from IDC account
    ssoBus.addToResourcePolicy(grantPutToIDCBus);
    
    // Existing VPC
    const lambdaVPC = Vpc.fromLookup(this, 'lambdaVPC', {
      vpcId: vpcID
    });

    // New SG for Lambda
    const lambdaSG = new SecurityGroup(this, "lambdaSG", {
      vpc: lambdaVPC,
      allowAllOutbound: true,
      description: "Create/Delete RDS User Lambda Function SG",
    });

    // Allow DB port from Lambda
    dbSG.connections.allowFrom(lambdaSG, Port.tcp(rdsDBPort), 'Allow DB from Lambda');

    /* DynamoDB table to store user ID to user name mappings
       This table is needed because the IAM Identity Center events don't contain user details
       And when users are deleted, there's no way to query for details
    */
    const rdsUserTable = new dynamodb.Table(this, 'ssoUserTable', {
      partitionKey: {name: 'userID', type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 2,
      writeCapacity: 2
    });

    // Lambda layer with boto3 and db clients for python Function
    const coreLayer = new PythonLayerVersion(this, "PL", {
      entry: path.join(__dirname, '../functions/layer'),
      compatibleRuntimes: [Runtime.PYTHON_3_12]
    });

    /* Lambda function triggered by a IAM IdC user creation
       Creates a new RDS user
       If a new SSO user is in a specific group
       Username in RDS equals to SSO username
    */
    const createRDSUserFunction: lambda.Function = new lambda.Function(this, 'createRDSUserFunction', {
      memorySize: 128,
      timeout: Duration.seconds(10),
      runtime: Runtime.PYTHON_3_12,
      handler: 'handler.handler',
      vpc: lambdaVPC,
      allowPublicSubnet: true, // Not needed with private subnets
      securityGroups: [lambdaSG],
      layers: [coreLayer],
      onFailure: props?.onFailureDest,
      environment: {
        RDS_DB_USER: rdsLambdaDBUser,
        RDS_DB_EP: rdsClusterEPAddr,
        RDS_DB_PORT: String(rdsDBPort),
        RDS_DB_ENGINE: rdsEngine,
        DDB_TABLE: rdsUserTable.tableName,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../functions/create-user-function'))
    });

    /* Lambda function triggered by a IAM IdC user deletion
       Deletes a user from RDS
       If a new SSO user was in a specific group
       Username in RDS equals to SSO username
    */
    const deleteRDSUserFunction: lambda.Function = new lambda.Function(this, 'deleteRDSUserFunction', {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_12,
        handler: 'handler.handler',
        vpc: lambdaVPC,
        allowPublicSubnet: true, // Not needed with private subnets
        securityGroups: [lambdaSG],
        layers: [coreLayer],
        onFailure: props?.onFailureDest,
        environment: {
          RDS_DB_USER: rdsLambdaDBUser,
          RDS_DB_EP: rdsClusterEPAddr,
          RDS_DB_PORT: String(rdsDBPort),
          RDS_DB_ENGINE: rdsEngine,
          DDB_TABLE: rdsUserTable.tableName,
        },
        code: lambda.Code.fromAsset(path.join(__dirname, '../functions/delete-user-function'))
      });

    // Grant Lambda functions RW access to DDB
    const actions = [
      'dynamodb:PutItem',
      'dynamodb:GetItem',
      'dynamodb:DeleteItem'
    ];
    rdsUserTable.grant(createRDSUserFunction, ...actions);
    rdsUserTable.grant(deleteRDSUserFunction, ...actions);

    /* Policy for Lambda to connect to the DB
       RDS must have preconfigured IAM Authentication and user
       RDS user must have at least CREATE USER permissions
    */
    const lambdaToRDSConnectPolicy = new iam.PolicyStatement({
      actions: [
        'rds-db:connect'
      ],
      resources: [
        `arn:aws:rds-db:${region}:${accountID}:dbuser:*/${rdsLambdaDBUser}`,
      ]
    });

    // RDS Connect policy
    const rdsConnectIamPolicy = new iam.Policy(this, 'lambda-to-rds-db-policy', {
      statements: [lambdaToRDSConnectPolicy]
    });

    // Grant both Lambda functions access to RDS DB
    createRDSUserFunction.role?.attachInlinePolicy(rdsConnectIamPolicy);
    deleteRDSUserFunction.role?.attachInlinePolicy(rdsConnectIamPolicy);

    // Default bus rule to match new IAM Identity Center users events
    const createSSOUserRule = new Rule(this, 'AddUserToGroupRule', {
      description: 'Add RDS user when an IAM Identity Center user is added to a group',
      eventPattern: {
        source: ["Lambda function: forward-create-event"],
      },
      eventBus: ssoBus,
    });

    // Default bus rule to match delete IAM Identity Center user events
    const deleteSSOUserRule = new Rule(this, 'DeleteSSOUserRule', {
      description: 'Deletes RDS user when user is deleted from IAM Identity Center',
      eventPattern: {
        source: ["Lambda function: forward-delete-event"],
      },
      eventBus: ssoBus,
    });

    // Add Lambda Functions as targets to the respective EventBridge Rules
    const deleteFunctionTarget = new events_targets.LambdaFunction(deleteRDSUserFunction);
    createSSOUserRule.addTarget(new events_targets.LambdaFunction(createRDSUserFunction));
    deleteSSOUserRule.addTarget(deleteFunctionTarget);

    // New VPC interface endpoint for Lambda functions to reach IAM Identity Center Store
    const vpeIDC = new InterfaceVpcEndpoint(this, 'VpcEpIDC', {
      vpc: lambdaVPC,
      service: new InterfaceVpcEndpointService(`com.amazonaws.${region}.identitystore`),
      privateDnsEnabled: true,
      open: false,
      subnets: {
        availabilityZones: lambdaVPC.availabilityZones.slice(0,2),
      }
    });

    // New VPC gateway endpoint for Lambda functions to reach DynamoDB
    new GatewayVpcEndpoint(this, 'VpcEpDDB', {
      vpc: lambdaVPC,
      service: GatewayVpcEndpointAwsService.DYNAMODB
    });

    // Allow VPC Endpoint from Lambda function
    vpeIDC.connections.allowDefaultPortFrom(lambdaSG, 'Allow from Lambda');

    // Output Lambda SG and RDS SG changed by CDK
    new CfnOutput(this, 'lambdaSGOut', { value: lambdaSG.securityGroupId });
    new CfnOutput(this, 'rdsSGOut', { value: dbSG.securityGroupId });

  }
}
