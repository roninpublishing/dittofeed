import {
  ArrowForward,
  CampaignOutlined,
  GroupsOutlined,
  LanOutlined,
  MailOutline,
  QueryStatsOutlined,
} from "@mui/icons-material";
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from "@mui/material";
import { db } from "backend-lib/src/db";
import { broadcast, journey, segment } from "backend-lib/src/db/schema";
import { and, desc, eq } from "drizzle-orm";
import { GetServerSideProps } from "next";
import Link from "next/link";

import DashboardContent from "../components/dashboardContent";
import { addInitialStateToProps } from "../lib/addInitialStateToProps";
import { useUniversalRouter } from "../lib/authModeProvider";
import { requestContext } from "../lib/requestContext";
import { PropsWithInitialState } from "../lib/types";

type HomeProps = PropsWithInitialState<{
  workspaceName: string;
  counts: { journeys: number; broadcasts: number; segments: number };
  recentJourneys: {
    id: string;
    name: string;
    status: string;
    createdAt: string;
  }[];
}>;

export const getServerSideProps: GetServerSideProps<HomeProps> = requestContext(
  async (_ctx, dfContext) => {
    const workspaceId = dfContext.workspace.id;
    const visibleJourneys = and(
      eq(journey.workspaceId, workspaceId),
      eq(journey.resourceType, "Declarative"),
    );
    const [journeys, broadcasts, segments, recent] = await Promise.all([
      db().$count(journey, visibleJourneys),
      db().$count(
        broadcast,
        and(
          eq(broadcast.workspaceId, workspaceId),
          eq(broadcast.archived, false),
        ),
      ),
      db().$count(
        segment,
        and(
          eq(segment.workspaceId, workspaceId),
          eq(segment.resourceType, "Declarative"),
        ),
      ),
      db().query.journey.findMany({
        where: visibleJourneys,
        columns: { id: true, name: true, status: true, createdAt: true },
        orderBy: [desc(journey.createdAt), desc(journey.id)],
        limit: 5,
      }),
    ]);

    return {
      props: addInitialStateToProps({
        dfContext,
        props: {
          workspaceName: dfContext.workspace.name,
          counts: { journeys, broadcasts, segments },
          recentJourneys: recent.map((item) => ({
            ...item,
            createdAt: item.createdAt.toISOString(),
          })),
        },
      }),
    };
  },
);

const createdDate = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "UTC",
});

const shortcuts = [
  {
    title: "Email templates",
    description: "Design and edit your messages.",
    href: "/templates",
    icon: MailOutline,
  },
  {
    title: "Journeys",
    description: "Build automated email workflows.",
    href: "/journeys",
    icon: LanOutlined,
  },
  {
    title: "Broadcasts",
    description: "Plan a campaign for your audience.",
    href: "/broadcasts",
    icon: CampaignOutlined,
  },
  {
    title: "Deliveries",
    description: "Review send results and engagement.",
    href: "/deliveries",
    icon: QueryStatsOutlined,
  },
];

export default function Home({
  workspaceName,
  counts,
  recentJourneys,
}: HomeProps) {
  const universalRouter = useUniversalRouter();
  const overview = [
    {
      title: "Journeys",
      count: counts.journeys,
      href: "/journeys",
      icon: LanOutlined,
    },
    {
      title: "Broadcasts",
      count: counts.broadcasts,
      href: "/broadcasts",
      icon: CampaignOutlined,
    },
    {
      title: "Segments",
      count: counts.segments,
      href: "/segments",
      icon: GroupsOutlined,
    },
  ];

  return (
    <DashboardContent>
      <Stack
        spacing={3}
        sx={{ p: { xs: 2, md: 3 }, width: "100%", overflow: "auto" }}
      >
        <Box>
          <Typography component="h1" variant="h2">
            Home
          </Typography>
          <Typography color="text.secondary" sx={{ mt: 0.5 }}>
            {workspaceName} workspace overview
          </Typography>
        </Box>

        <Box
          sx={{
            display: "grid",
            gap: 2,
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              sm: "repeat(3, minmax(0, 1fr))",
            },
          }}
        >
          {overview.map(({ title, count, href, icon: Icon }) => (
            <Box key={title} sx={{ minWidth: 0 }}>
              <Card variant="outlined">
                <CardActionArea component={Link} href={href} sx={{ p: 3 }}>
                  <Stack
                    direction="row"
                    justifyContent="space-between"
                    alignItems="center"
                  >
                    <Box>
                      <Typography color="text.secondary">{title}</Typography>
                      <Typography variant="h2" sx={{ mt: 1 }}>
                        {count.toLocaleString("en-US")}
                      </Typography>
                    </Box>
                    <Box
                      sx={{
                        p: 1.5,
                        borderRadius: 2,
                        bgcolor: "primary.lighter",
                        color: "primary.main",
                      }}
                    >
                      <Icon />
                    </Box>
                  </Stack>
                </CardActionArea>
              </Card>
            </Box>
          ))}
        </Box>

        <Box
          sx={{
            display: "grid",
            gap: 3,
            alignItems: "start",
            gridTemplateColumns: {
              xs: "minmax(0, 1fr)",
              lg: "minmax(0, 2fr) minmax(0, 1fr)",
            },
          }}
        >
          <Box sx={{ minWidth: 0 }}>
            <Card variant="outlined">
              <CardContent>
                <Stack
                  direction="row"
                  justifyContent="space-between"
                  alignItems="center"
                  spacing={1}
                >
                  <Typography component="h2" variant="h4">
                    Recent journeys
                  </Typography>
                  <Button
                    component={Link}
                    href="/journeys"
                    endIcon={<ArrowForward />}
                  >
                    View all
                  </Button>
                </Stack>
              </CardContent>
              <TableContainer>
                <Table size="small" aria-label="Recent journeys">
                  <TableHead>
                    <TableRow>
                      <TableCell>Name</TableCell>
                      <TableCell>Status</TableCell>
                      <TableCell>Created (UTC)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {recentJourneys.length ? (
                      recentJourneys.map((item) => (
                        <TableRow key={item.id} hover>
                          <TableCell>
                            <Button
                              component={Link}
                              href={universalRouter.mapUrl("/journeys/v2", {
                                id: item.id,
                              })}
                              sx={{ textAlign: "left" }}
                            >
                              {item.name}
                            </Button>
                          </TableCell>
                          <TableCell>
                            <Chip
                              size="small"
                              variant="outlined"
                              label={item.status.replace(
                                /([a-z])([A-Z])/g,
                                "$1 $2",
                              )}
                            />
                          </TableCell>
                          <TableCell>
                            {createdDate.format(new Date(item.createdAt))}
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell
                          colSpan={3}
                          sx={{ py: 5, textAlign: "center" }}
                        >
                          <Typography variant="subtitle1">
                            No journeys yet
                          </Typography>
                          <Typography
                            color="text.secondary"
                            variant="body2"
                            sx={{ mt: 1 }}
                          >
                            Start with an email template, then build your first
                            journey.
                          </Typography>
                          <Button
                            component={Link}
                            href="/journeys"
                            sx={{ mt: 2 }}
                          >
                            Open journeys
                          </Button>
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Card variant="outlined">
              <CardContent>
                <Typography component="h2" variant="h4">
                  Quick access
                </Typography>
              </CardContent>
              <List disablePadding sx={{ pb: 1 }}>
                {shortcuts.map(({ title, description, href, icon: Icon }) => (
                  <ListItemButton key={href} component={Link} href={href}>
                    <ListItemIcon sx={{ minWidth: 40 }}>
                      <Icon color="primary" />
                    </ListItemIcon>
                    <ListItemText primary={title} secondary={description} />
                    <ArrowForward fontSize="small" color="action" />
                  </ListItemButton>
                ))}
              </List>
            </Card>
          </Box>
        </Box>
      </Stack>
    </DashboardContent>
  );
}
