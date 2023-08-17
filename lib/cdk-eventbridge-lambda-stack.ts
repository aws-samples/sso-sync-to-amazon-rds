import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Vpc, SecurityGroup, InterfaceVpcEndpoint, InterfaceVpcEndpointService, Port, GatewayVpcEndpoint, GatewayVpcEndpointAwsService } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { ImportedRDSCluster } from './imported-rds-cluster';
import { ImportedIamIdc, ImportedIamIdcGroup } from './imported-iam-idc';

interface NewSSOUserProps extends cdk.StackProps {
  onFailureDest: lambda.IDestination | undefined;
}

export class NewSSOUserToRDS extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: NewSSOUserProps) {
    super(scope, id, props);

    // Get environment to work with, variables are specified in cdk.json
    const env = process.env.CDK_ENV || "dev";
    const context = this.node.tryGetContext(env);

    const accountID = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    // Specify comma separated list of groups or just a single group
    const groupNames = context.IAM_IDC_GROUP_NAMES.split(",");
    let identityStoreID = context.IAM_IDC_STORE_ID;
    const vpcID = context.VPC_ID;

    const rdsDBPort = context.RDS_DB_PORT || 3306;
    const rdsClusterID = context.RDS_CLUSTER_ID;
    const rdsLambdaDBUser = context.RDS_DB_USER;
    const rdsAccountID = context.RDS_ACCOUNT_ID || accountID;

    // If IAM IdC Store ID is not specified in the context, get it dynamically
    if (identityStoreID == null) {
      identityStoreID = new ImportedIamIdc(this, 'importedIdc', { TargetRegion: region }).idcID;
    }

    // Empty object for group membership data
    let groups: { [groupID: string] : string } = {};
    let groupIDs: string[] = [];

    // Get data for each configured group name
    for (let groupName of groupNames) {
          // Existing Group ID to check against when adding new user to RDS (ex.: DBA group)
          const groupID = new ImportedIamIdcGroup(this, 'iamIdcGroupId' + groupName, {
            TargetRegion: region, 
            TargetIDC: identityStoreID,
            GroupName: groupName
          }).groupID;

          // Populate group objects
          groups[groupID] = groupName;
          groupIDs.push(groupID);
    }
    
    // Existing RDS Cluster to get info from
    const existingRdsCluster = new ImportedRDSCluster(this, 'existingRDS', {
      TargetRegion: region, 
      TargetAccount: rdsAccountID,
      DBClusterIdentifier: rdsClusterID
    });
    
    const rdsClusterEPAddr = existingRdsCluster.endpoint;
    const dbSgID = existingRdsCluster.vpcSgId;

    // Existing RDS Security Group (first available is selected)
    const dbSG = SecurityGroup.fromSecurityGroupId(this, 'dbSG', dbSgID, {
      mutable: true
    });

    // Existing default EventBridge bus
    const defaultBus = EventBus.fromEventBusName(this, 'defaultBus', 'default');
    
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

    // Allow MySQL 3306 from Lambda
    dbSG.connections.allowFrom(lambdaSG, Port.tcp(rdsDBPort), 'Allow MySQL from Lambda');

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

    // Lambda layer with boto3 and mysql client for python Function
    const coreLayer = new lambda.LayerVersion(this, 'coreLayer', {
        code: lambda.Code.fromAsset(path.join(__dirname, '../src/layer')),
        compatibleRuntimes: [Runtime.PYTHON_3_10]
    });

    /* Lambda function triggered by a IAM IdC user creation
       Creates a new RDS user
       If a new SSO user is in a specific group
       Username in RDS equals to SSO username
    */
    const createRDSUserFunction: lambda.Function = new lambda.Function(this, 'createRDSUserFunction', {
      memorySize: 128,
      timeout: Duration.seconds(10),
      runtime: Runtime.PYTHON_3_10,
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
        DDB_TABLE: rdsUserTable.tableName,
        IDENTITYSTORE_GROUP_IDS: JSON.stringify(groups),
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/create-user-function/handler'))
    });

    /* Lambda function triggered by a IAM IdC user deletion
       Deletes a user from RDS
       If a new SSO user was in a specific group
       Username in RDS equals to SSO username
    */
    const deleteRDSUserFunction: lambda.Function = new lambda.Function(this, 'deleteRDSUserFunction', {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_10,
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
          DDB_TABLE: rdsUserTable.tableName,
          IDENTITYSTORE_GROUP_IDS: JSON.stringify(groups),
        },
        code: lambda.Code.fromAsset(path.join(__dirname, '../src/delete-user-function/handler'))
      });

    // Grant Lambda functions RW access to DDB
    const actions = [
      'dynamodb:PutItem',
      'dynamodb:GetItem',
      'dynamodb:DeleteItem'
    ];
    rdsUserTable.grant(createRDSUserFunction, ...actions);
    rdsUserTable.grant(deleteRDSUserFunction, ...actions);

    // Policy that allows read access to IAM Identity Center Store
    const lambdaToIAMIdCAccessPolicy = new iam.PolicyStatement({
      actions: [
        'identitystore:DescribeUser', // To get username
        'identitystore:IsMemberInGroups', // To check group membership
      ],
      resources: [
        'arn:aws:identitystore:::user/*',
        'arn:aws:identitystore:::membership/*',
        `arn:aws:identitystore:::group/*`,
        `arn:aws:identitystore::${accountID}:identitystore/${identityStoreID}`,
      ] 
    });

    /* Policy for Lambda to connect to the DB
       RDS must have preconfigured IAM Authentication and user
       RDS user must have at least CREATE USER permissions
    */
    const lambdaToRDSConnectPolicy = new iam.PolicyStatement({
      actions: [
        'rds-db:connect'
      ],
      resources: [
        `arn:aws:rds-db:${region}:${rdsAccountID}:dbuser:*/${rdsLambdaDBUser}`,
      ]
    });

    // Grant Lambda function read access to IAM Identity Center Store
    createRDSUserFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'lambda-to-iam-identitycenter-policy', {
        statements: [lambdaToIAMIdCAccessPolicy]
      })
    );

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
        source: ["aws.sso-directory"],
        detail: {
          "eventSource": ["sso-directory.amazonaws.com"],
          "eventName": ["AddMemberToGroup"],
          "requestParameters": {
            "groupId": groupIDs // Only matches a specific set of groups
          }
        }
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match delete IAM Identity Center user events
    const deleteSSOUserRule = new Rule(this, 'DeleteSSOUserRule', {
      description: 'Deletes RDS user when user is deleted from IAM Identity Center',
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          "eventSource": ["sso-directory.amazonaws.com"],
          "eventName": ["DeleteUser"]
        }
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match remove IAM Identity Center user from group events
    const removeSSOUserFromGroupoRule = new Rule(this, 'RemoveUserFromGroupRule', {
      description: 'Deletes RDS user when user is deleted from an IAM Identity Center group',
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          "eventSource": ["sso-directory.amazonaws.com"],
          "eventName": ["RemoveMemberFromGroup"],
          "requestParameters": {
            "groupId": groupIDs // Only matches a specific set of groups
          }
        }
      },
      eventBus: defaultBus,
    });

    // Add Lambda Functions as targets to the respective EventBridge Rules
    const deleteFunctionTarget = new events_targets.LambdaFunction(deleteRDSUserFunction);
    createSSOUserRule.addTarget(new events_targets.LambdaFunction(createRDSUserFunction));
    deleteSSOUserRule.addTarget(deleteFunctionTarget);
    removeSSOUserFromGroupoRule.addTarget(deleteFunctionTarget);

    // New VPC interface endpoint for Lambda functions to reach IAM Identity Center Store
    const vpeIDC = new InterfaceVpcEndpoint(this, 'VpcEpIDC', {
      vpc: lambdaVPC,
      service: new InterfaceVpcEndpointService(`com.amazonaws.${region}.identitystore`),
      privateDnsEnabled: true,
      open: false
    });

    // New VPC gateway endpoint for Lambda functions to reach DynamoDB
    const vpeDDB = new GatewayVpcEndpoint(this, 'VpcEpDDB', {
      vpc: lambdaVPC,
      service: GatewayVpcEndpointAwsService.DYNAMODB
    });

    // Allow VPC Endpoint from Lambda function
    vpeIDC.connections.allowDefaultPortFrom(lambdaSG, 'Allow from Lambda');

    // Output Lambda SG and RDS SG changed by CDK
    new CfnOutput(this, 'lambdaSGOut', { value: lambdaSG.securityGroupId });
    new CfnOutput(this, 'rdsSGOut', {value: dbSG.securityGroupId});
    new CfnOutput(this, 'identityStoreID', {value: identityStoreID});

  }
}
