import { json as codeMirrorJson } from "@codemirror/lang-json";
import { EditorView } from "@codemirror/view";
import { Stack, Typography, useTheme } from "@mui/material";
import ReactCodeMirror from "@uiw/react-codemirror";
import logger from "backend-lib/src/logger";
import { getUsers } from "backend-lib/src/users";
import {
  LAST_CLICKED_PROPERTY_NAME,
  LAST_OPENED_PROPERTY_NAME,
} from "isomorphic-lib/src/constants";
import { GetUsersResponse } from "isomorphic-lib/src/types";
import { GetServerSideProps, NextPage } from "next";

import { SubtleHeader } from "../../components/headers";
import { UserLayout } from "../../components/userLayout";
import { addInitialStateToProps } from "../../lib/addInitialStateToProps";
import { requestContext } from "../../lib/requestContext";
import { PropsWithInitialState } from "../../lib/types";

interface UserPageProps {
  user: GetUsersResponse["users"][0];
}

export const getServerSideProps: GetServerSideProps<
  PropsWithInitialState<UserPageProps>
> = requestContext(async (ctx, dfContext) => {
  const userId = ctx.query.id;
  if (typeof userId !== "string") {
    return { notFound: true };
  }

  const usersResult = await getUsers({
    workspaceId: dfContext.workspace.id,
    userIds: [userId],
  });

  if (usersResult.isErr()) {
    logger().error({ err: usersResult.error }, "Unable to retrieve user");
    throw new Error("Unable to retrieve user");
  }

  const [user] = usersResult.value.users;

  if (!user) {
    return { notFound: true };
  }

  return {
    props: addInitialStateToProps({
      serverInitialState: {},
      dfContext,
      props: { user },
    }),
  };
});

const User: NextPage<UserPageProps> = function User(props) {
  const { user } = props;
  const theme = useTheme();
  const lastClicked = Object.values(user.properties).find(
    (property) => property.name === LAST_CLICKED_PROPERTY_NAME,
  )?.value;
  const lastOpened = Object.values(user.properties).find(
    (property) => property.name === LAST_OPENED_PROPERTY_NAME,
  )?.value;
  const properties = JSON.stringify(
    Object.values(user.properties).reduce<Record<string, string>>(
      (acc, property) => {
        acc[property.name] = property.value;
        return acc;
      },
      {},
    ),
    null,
    2,
  );

  return (
    <UserLayout userId={user.id}>
      <Stack spacing={1} sx={{ mb: 3 }}>
        <SubtleHeader>Last clicked</SubtleHeader>
        <Typography>
          {typeof lastClicked === "string" && lastClicked
            ? lastClicked
            : "No click observed"}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Latest observed email click, by event time (UTC), across sends.
          Automated scanners can count; this is not verified human engagement.
        </Typography>
      </Stack>
      <Stack spacing={1} sx={{ mb: 3 }}>
        <SubtleHeader>Last opened</SubtleHeader>
        <Typography>
          {typeof lastOpened === "string" && lastOpened
            ? lastOpened
            : "No open observed"}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Latest observed email open, by event time (UTC), across sends.
          Privacy proxies and automated scanners can count; this is not verified
          human engagement.
        </Typography>
      </Stack>
      <SubtleHeader>User Properties</SubtleHeader>
      <ReactCodeMirror
        value={properties}
        readOnly
        extensions={[
          codeMirrorJson(),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": {
              fontFamily: theme.typography.fontFamily,
            },
          }),
        ]}
      />
    </UserLayout>
  );
};

export default User;
