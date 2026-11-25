// material-ui
import { ExpandLess, ExpandMore } from "@mui/icons-material";
import { Collapse, List, ListItemButton, ListItemText } from "@mui/material";
import { useRouter } from "next/router";
import { useId, useState } from "react";

import { activeNavigationUrl } from "../../../../../lib/navigation";
import { MenuItemGroup } from "../../../../menuItems/types";
import Link from "../../../../workspace/navigation";
import MinimalNavItem from "./minimalNavItem";
// project import

// ==============================|| NAVIGATION - LIST GROUP ||============================== //

function MinimalNavGroup({ item }: { item: MenuItemGroup }) {
  const { asPath } = useRouter();
  const selectedUrl = activeNavigationUrl(
    asPath,
    item.children.map((child) => child.url),
  );
  const [isExpanded, setIsExpanded] = useState(true);
  const childrenId = useId();
  const hasChildren = item.children.length > 0;

  const navCollapse = item.children.map((menuItem) => (
    <MinimalNavItem
      key={menuItem.id}
      item={menuItem}
      level={1}
      isSelected={menuItem.url === selectedUrl}
    />
  ));
  const toggleExpand = () => {
    setIsExpanded(!isExpanded);
  };
  const Arrow = isExpanded ? ExpandLess : ExpandMore;

  return hasChildren ? (
    <List sx={{ mb: 1, py: 0, zIndex: 0 }}>
      <ListItemButton
        onClick={toggleExpand}
        aria-expanded={isExpanded}
        aria-controls={childrenId}
        sx={{
          px: 1,
          py: 0.5,
          minHeight: 36,
          borderRadius: 1,
          "&.Mui-focusVisible": {
            outline: "2px solid",
            outlineColor: "primary.main",
            outlineOffset: -2,
          },
        }}
      >
        <ListItemText primary={item.title} />
        <Arrow sx={{ fontSize: 16 }} />
      </ListItemButton>
      <Collapse in={isExpanded} timeout={0}>
        <List id={childrenId} component="div" disablePadding>
          {navCollapse}
        </List>
      </Collapse>
    </List>
  ) : (
    <ListItemButton
      href={item.url ?? ""}
      component={item.external ? "a" : Link}
      sx={{
        px: 1,
        py: 0.5,
        minHeight: 36,
        borderRadius: 1,
        mb: 1,
        "&.Mui-focusVisible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: -2,
        },
        zIndex: 0,
      }}
    >
      <ListItemText primary={item.title} />
    </ListItemButton>
  );
}

export default MinimalNavGroup;
