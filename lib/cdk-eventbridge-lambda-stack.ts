import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as events_targets from 'aws-cdk-lib/aws-events-targets';
import { Vpc, SecurityGroup, InterfaceVpcEndpoint, InterfaceVpcEndpointService, Port } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { CfnOutput, Duration } from 'aws-cdk-lib';
import { EventBus, Rule } from 'aws-cdk-lib/aws-events';
import { Runtime } from 'aws-cdk-lib/aws-lambda';
import { ImportedRDSCluster } from './imported-rds-cluster';
import { ImportedIamIdc, ImportedIamIdcGroup } from './imported-iam-idc';

export class NewSSOUserToRDS extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Get environment to work with, variables are specified in cdk.json
    const env = process.env.CDK_ENV || "dev";
    const context = this.node.tryGetContext(env);

    const accountID = cdk.Stack.of(this).account;
    const region = cdk.Stack.of(this).region;

    const groupName = context.IAM_IDC_GROUP_NAME;
    let identityStoreID = context.IAM_IDC_STORE_ID;
    const vpcID = context.VPC_ID;

    const rdsDBName = context.RDS_DB_NAME;
    const rdsDBPort = context.RDS_DB_PORT || 3306;
    const rdsClusterID = context.RDS_CLUSTER_ID;
    const rdsLambdaDBUser = context.RDS_DB_USER;
    const rdsAccountID = context.RDS_ACCOUNT_ID || accountID;

    // If IAM IdC Store ID is not specified in the context, get it dynamically
    if (identityStoreID == null) {
      identityStoreID = new ImportedIamIdc(this, 'importedIdc', { TargetRegion: region }).idcID;
    }

    // Existing Group ID to check against when adding new user to RDS (ex.: DBA group)
    const groupID = new ImportedIamIdcGroup(this, 'iamIdcGroupId', {
      TargetRegion: region, 
      TargetIDC: identityStoreID, 
      GroupName: groupName
    }).groupID;

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
      description: "Create RDS User Lambda Function SG",
    });

    // Allow MySQL 3306 from Lambda
    dbSG.connections.allowFrom(lambdaSG, Port.tcp(rdsDBPort), 'Allow MySQL from Lambda');

    // Lambda layer with boto3 and mysql client for python Function
    const coreLayer = new lambda.LayerVersion(this, 'coreLayer', {
        code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda-function/layer')),
        compatibleRuntimes: [Runtime.PYTHON_3_10]
    });

    /* Lambda Function triggered by a IAM IdC user creation
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
      environment: {
        RDS_DB_NAME: rdsDBName,
        RDS_DB_USER: rdsLambdaDBUser,
        RDS_DB_EP: rdsClusterEPAddr,
        RDS_DB_PORT: String(rdsDBPort),
        IDENTITYSTORE_GROUP_ID: groupID,
      },
      code: lambda.Code.fromAsset(path.join(__dirname, '../src/lambda-function/handler'))
    });

    // Policy that allows read access to IAM Identity Center Store
    const lambdaToIAMIdCAccessPolicy = new iam.PolicyStatement({
      actions: [
        'identitystore:DescribeUser', // To get username
        'identitystore:IsMemberInGroups', // To check group membership
      ],
      resources: [
        'arn:aws:identitystore:::user/*',
        'arn:aws:identitystore:::membership/*',
        `arn:aws:identitystore:::group/${groupID}`,
        `arn:aws:identitystore::${accountID}:identitystore/${identityStoreID}`,
      ] 
    });

    /* Policy for lambda to connect to the DB
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

    // Grant lambda function read access to IAM Identity Center Store
    createRDSUserFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'lambda-to-iam-identitycenter-policy', {
        statements: [lambdaToIAMIdCAccessPolicy]
      })
    );

    // Grant lambda function access to RDS DB
    createRDSUserFunction.role?.attachInlinePolicy(
      new iam.Policy(this, 'lambda-to-rds-db-policy', {
        statements: [lambdaToRDSConnectPolicy]
      })
    );

    // Default bus rule to match new IAM Identity Center users events
    const newSSOUserRule = new Rule(this, 'NewSSOUserRule', {
      description: 'Add RDS user when new IAM Identity Center user is created or added to a group',
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          "eventSource": ["sso-directory.amazonaws.com"],
          "eventName": ["CreateUser", "AddMemberToGroup"]
        }
      },
      eventBus: defaultBus,
    });

    // Add Lambda Function as a target to the EventBridge Rule
    newSSOUserRule.addTarget(new events_targets.LambdaFunction(createRDSUserFunction));

    // New VPC Endpoint for Lambda to reach IAM Identity Center Store
    const vpeIDC = new InterfaceVpcEndpoint(this, 'VpcEpIDC', {
      vpc: lambdaVPC,
      service: new InterfaceVpcEndpointService(`com.amazonaws.${region}.identitystore`),
      privateDnsEnabled: true,
      open: false
    });

    // Allow VPC Endpoint from Lambda function
    vpeIDC.connections.allowDefaultPortFrom(lambdaSG, 'Allow from Lambda');

    // Output Lambda SG and RDS SG changed by CDK
    new CfnOutput(this, 'lambdaSGOut', { value: lambdaSG.securityGroupId });
    new CfnOutput(this, 'rdsSGOut', {value: dbSG.securityGroupId});
    new CfnOutput(this, 'groupID', {value: groupID});
    new CfnOutput(this, 'identityStoreID', {value: identityStoreID});

  }
}
