import * as path from "path";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events_targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import { Duration } from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { ImportedIamIdc, ImportedIamIdcGroup } from "./imported-iam-idc";

export class EventBridgeSSOLambda extends cdk.Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    // Get environment to work with, variables are specified in cdk.json
    const env = process.env.CDK_ENV || "dev";
    const context = this.node.tryGetContext(env);

    // RDS account and region
    const rdsAccountID = context.RDS_ACCOUNT_ID;
    const rdsRegion = context.RDS_REGION;

    // Identity Center region and account
    const region = cdk.Stack.of(this).region;
    const accountID = cdk.Stack.of(this).account;

    // Specify comma separated list of groups or just a single group
    const groupNames = context.IAM_IDC_GROUP_NAMES.split(",");

    // Get IAM IdC Store ID
    const identityStoreID = new ImportedIamIdc(this, "importedIdc", {
      TargetRegion: region,
    }).idcID;

    // Empty object for group membership data
    let groups: { [groupID: string]: string } = {};
    let groupIDs: string[] = [];

    // Get data for each configured group name
    for (let groupName of groupNames) {
      // Existing Group ID to check against when adding new user to RDS (ex.: DBA group)
      const groupID = new ImportedIamIdcGroup(
        this,
        "iamIdcGroupId" + groupName,
        {
          TargetRegion: region,
          TargetIDC: identityStoreID,
          GroupName: groupName,
        },
      ).groupID;

      // Populate group objects
      groups[groupID] = groupName;
      groupIDs.push(groupID);
    }

    // Existing default EventBridge bus
    const defaultBus = EventBus.fromEventBusName(this, "defaultBus", "default");

    // Custom bus for cross-account event routing
    const ssoBus = new EventBus(this, "ssoBus", {
      eventBusName: "SSO-RDS-Sync-Source",
    });

    // Default bus rule to match new IAM Identity Center users events
    const createSSOUserRule = new Rule(this, "AddUserToGroupRule", {
      description:
        "Add RDS user when an IAM Identity Center user is added to a group",
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          eventSource: ["sso-directory.amazonaws.com"],
          eventName: ["AddMemberToGroup"],
          requestParameters: {
            groupId: groupIDs, // Only matches a specific set of groups
          },
        },
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match delete IAM Identity Center user events
    const deleteSSOUserRule = new Rule(this, "DeleteSSOUserRule", {
      description:
        "Deletes RDS user when user is deleted from IAM Identity Center",
      eventPattern: {
        source: ["aws.sso-directory"],
        detail: {
          eventSource: ["sso-directory.amazonaws.com"],
          eventName: ["DeleteUser"],
        },
      },
      eventBus: defaultBus,
    });

    // Default bus rule to match remove IAM Identity Center user from group events
    const removeSSOUserFromGroupoRule = new Rule(
      this,
      "RemoveUserFromGroupRule",
      {
        description:
          "Deletes RDS user when user is deleted from an IAM Identity Center group",
        eventPattern: {
          source: ["aws.sso-directory"],
          detail: {
            eventSource: ["sso-directory.amazonaws.com"],
            eventName: ["RemoveMemberFromGroup"],
            requestParameters: {
              groupId: groupIDs, // Only matches a specific set of groups
            },
          },
        },
        eventBus: defaultBus,
      },
    );

    // Lambda function triggered by a IAM IdC user creation
    const forwardCreateFunction: lambda.Function = new lambda.Function(
      this,
      "forwardCreateEvent",
      {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_12,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../functions/forward-create-event"),
        ),
        environment: {
          DEST_BUS_NAME: ssoBus.eventBusName,
          IDENTITYSTORE_GROUP_IDS: JSON.stringify(groups)
        },
      },
    );

    // Lambda function triggered by a IAM IdC user deletion
    const forwardDeleteFunction: lambda.Function = new lambda.Function(
      this,
      "forwardDeleteEvent",
      {
        memorySize: 128,
        timeout: Duration.seconds(10),
        runtime: Runtime.PYTHON_3_12,
        handler: "handler.handler",
        code: lambda.Code.fromAsset(
          path.join(__dirname, "../functions/forward-delete-event"),
        ),
        environment: {
          DEST_BUS_NAME: ssoBus.eventBusName,
          IDENTITYSTORE_GROUP_IDS: JSON.stringify(groups)
        },
      },
    );

    // Policy that allows read access to IAM Identity Center Store
    const lambdaToIAMIdCAccessPolicy = new iam.PolicyStatement({
      actions: [
        "identitystore:DescribeUser", // To get username
        "identitystore:IsMemberInGroups", // To check group membership
      ],
      resources: [
        "arn:aws:identitystore:::user/*",
        "arn:aws:identitystore:::membership/*",
        `arn:aws:identitystore:::group/*`,
        `arn:aws:identitystore::${accountID}:identitystore/${identityStoreID}`,
      ],
    });

    // Grant Lambda function read access to IAM Identity Center Store
    forwardCreateFunction.role?.attachInlinePolicy(
      new iam.Policy(this, "lambda-to-iam-identitycenter-policy", {
        statements: [lambdaToIAMIdCAccessPolicy],
      }),
    );

    // Add Lambda Functions as targets to the default bus create rule
    const forwardCreateFuncTarget = new events_targets.LambdaFunction(
      forwardCreateFunction,
    );
    const forwardDeleteFuncTarget = new events_targets.LambdaFunction(
      forwardDeleteFunction,
    );

    createSSOUserRule.addTarget(forwardCreateFuncTarget);
    deleteSSOUserRule.addTarget(forwardDeleteFuncTarget);
    removeSSOUserFromGroupoRule.addTarget(forwardDeleteFuncTarget);

    // Allow Lambda to put events
    ssoBus.grantPutEventsTo(forwardCreateFunction);
    ssoBus.grantPutEventsTo(forwardDeleteFunction);

    const forwardAllTarget = new events_targets.EventBus(
      EventBus.fromEventBusArn(
        this,
        "rdsAccountCustomBus",
        `arn:aws:events:${rdsRegion}:${rdsAccountID}:event-bus/SSO-RDS-Sync-Target`,
      ),
    );

    new Rule(this, "ForwardAll", {
      description: "Forwards all event to RDS account",
      eventPattern: {
        source: [{ prefix: "" }] as any[],
      },
      eventBus: ssoBus,
      targets: [forwardAllTarget],
    });
  }
}
