// project import
import Badge from "./Badge";
import Button from "./Button";
import ButtonBase from "./ButtonBase";
import Card from "./Card";
import CardContent from "./CardContent";
import Checkbox from "./Checkbox";
import Chip from "./Chip";
import IconButton from "./IconButton";
import Input from "./Input";
import InputLabel from "./InputLabel";
import LinearProgress from "./LinearProgress";
import Link from "./Link";
import ListItemIcon from "./ListItemIcon";
import Tab from "./Tab";
import TableCell from "./TableCell";
import Tabs from "./Tabs";
import Typography from "./Typography";

// ==============================|| OVERRIDES - MAIN ||============================== //

export default function ComponentsOverrides(theme) {
  return Object.assign(
    Button(theme),
    ButtonBase(theme),
    Card(theme),
    Badge(theme),
    CardContent(),
    Checkbox(theme),
    Chip(theme),
    IconButton(theme),
    Input(theme),
    InputLabel(theme),
    LinearProgress(),
    Link(theme),
    ListItemIcon(),
    Tab(theme),
    TableCell(theme),
    Tabs(),
    Typography(),
  );
}
