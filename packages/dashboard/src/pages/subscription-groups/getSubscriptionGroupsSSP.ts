import { db } from "backend-lib/src/db";
import * as schema from "backend-lib/src/db/schema";
import { subscriptionGroupToResource } from "backend-lib/src/subscriptionGroups";
import { and, eq } from "drizzle-orm";
import { GetServerSideProps } from "next";
import { validate } from "uuid";

import { addInitialStateToProps } from "../../lib/addInitialStateToProps";
import { isChannelVisible } from "../../lib/channelVisibility";
import { requestContext } from "../../lib/requestContext";
import { PropsWithInitialState } from "../../lib/types";

const getSubscriptionGroupsSSP: GetServerSideProps<PropsWithInitialState> =
  requestContext(async (ctx, dfContext) => {
    const id = ctx.params?.id;

    if (typeof id !== "string" || !validate(id)) {
      return {
        notFound: true,
      };
    }

    const subscriptionGroup = await db().query.subscriptionGroup.findFirst({
      where: and(
        eq(schema.subscriptionGroup.id, id),
        eq(schema.subscriptionGroup.workspaceId, dfContext.workspace.id),
      ),
    });
    if (
      subscriptionGroup &&
      !isChannelVisible(subscriptionGroupToResource(subscriptionGroup).channel)
    ) {
      return { notFound: true };
    }

    return {
      props: addInitialStateToProps({
        serverInitialState: {},
        props: {},
        dfContext,
      }),
    };
  });

export default getSubscriptionGroupsSSP;
